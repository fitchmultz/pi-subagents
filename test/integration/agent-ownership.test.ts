import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test as nodeTest, type TestContext } from "node:test";
import { assertRecord, records, text } from "../support/assertions.ts";
import { waitFor } from "../support/native-readiness.ts";
import { NativeDebugger } from "../support/native-debugger.ts";
import type { UnknownRecord } from "../../src/shared/unknown.ts";
import type { Launch } from "../../src/agent/contracts.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class Main {
  readonly child: ChildProcess;
  readonly exited: Promise<unknown[]>;
  readonly actors = new Set<number>();
  readonly endpoint: Promise<string>;
  readonly ready: Promise<UnknownRecord>;
  inspector: NativeDebugger | undefined;

  constructor(root: string) {
    this.child = fork(path.join(repo, "test/fixtures/ownership-main.ts"), [root], {
      detached: true,
      execArgv: ["--inspect=127.0.0.1:0"],
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
        PI_INTERCOM_RUNTIME_DIR: path.join(root, "runtime"),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.exited = once(this.child, "exit");
    this.ready = this.reply("ready");
    this.child.on("message", (message: unknown) => {
      assertRecord(message);
      if (message.record !== undefined) {
        assertRecord(message.record);
        if (typeof message.record.pid === "number") {
          this.actors.add(message.record.pid);
        }
      }
    });
    this.endpoint = new Promise((resolve) => {
      let stderr = "";
      this.child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const endpoint = /ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.exec(stderr)?.[0];
        if (endpoint !== undefined) {
          resolve(endpoint);
        }
      });
    });
  }

  reply(action: string): Promise<UnknownRecord> {
    return new Promise((resolve) => {
      const receive = (message: unknown) => {
        assertRecord(message);
        if (action === "ready" ? message.ready === true : message.action === action) {
          this.child.off("message", receive);
          resolve(message);
        }
      };
      this.child.on("message", receive);
    });
  }

  request(action: string): Promise<UnknownRecord> {
    const result = this.reply(action);
    this.child.send({ action });
    return result;
  }

  async debug(): Promise<NativeDebugger> {
    this.inspector = await NativeDebugger.connect(await this.endpoint);
    return this.inspector;
  }

  async stop(): Promise<void> {
    this.inspector?.close();
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

async function setup(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/pso-"));
  const base = path.join(root, "owner");
  const directory = path.join(base, "run");
  fs.mkdirSync(path.join(directory, "actor.lock"), { recursive: true });
  fs.mkdirSync(path.join(root, "runtime"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "agent"));
  const launch: Launch = {
    version: 1,
    id: "run",
    rootId: "run",
    owner: "same-session",
    cwd: root,
    agentDir: path.join(root, "agent"),
    sdk: path.join(repo, "node_modules/@earendil-works/pi-coding-agent"),
    entry: path.join(repo, "src/agent/index.ts"),
    sessionFile: path.join(directory, "child.jsonl"),
    sessionId: "same-journal",
    prompt: "held at native debugger entry before SDK/provider work",
    context: "fresh",
    provider: "unused",
    model: "unused",
    thinking: "off",
    trusted: true,
    createdAt: Date.now(),
  };
  fs.writeFileSync(path.join(root, "launch.json"), JSON.stringify(launch));
  fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify(launch));
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(dead, "exit");
  assert.ok(dead.pid !== undefined && !alive(dead.pid));
  fs.writeFileSync(
    path.join(directory, "actor.lock/process.json"),
    JSON.stringify({ pid: dead.pid, identity: "unverified", token: "exited-generation" }),
  );
  const a = new Main(root);
  const b = new Main(root);
  t.after(async () => {
    const actors = new Set([...a.actors, ...b.actors]);
    for (const pid of actors) {
      if (alive(pid)) {
        process.kill(-pid, "SIGKILL");
      }
    }
    await Promise.all([a.stop(), b.stop()]);
    await waitFor(() => [...actors].every((pid) => !alive(pid)), "owned native runners exit");
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([a.ready, b.ready]);
  return { a, b, root, base, directory };
}

nodeTest("simultaneous main attachment cannot both publish after reading no owner", async (t) => {
  const { a, b, base } = await setup(t);
  const inspector = await a.debug();
  const breakpoint = await inspector.before(
    path.join(repo, "src/agent/attachment.ts"),
    "write(file,",
  );
  const first = a.request("attach");
  const paused = await inspector.pause();
  assert.equal(records(paused.callFrames)[0]?.functionName, "publishAttachment");
  assert.equal(fs.existsSync(path.join(base, "attachment.json")), false);
  const contender = await b.request("attach");
  assert.equal(
    contender.ok,
    false,
    "native lock excludes publication while the first main is paused",
  );
  assert.match(text(contender.error), /Agent ownership is changing/);
  await inspector.resume(breakpoint);
  assert.equal((await first).ok, true);
  const late = await b.request("attach");
  assert.equal(late.ok, false);
  assert.match(text(late.error), /Another live main is attached/);
  const saved: unknown = JSON.parse(fs.readFileSync(path.join(base, "attachment.json"), "utf8"));
  assertRecord(saved);
  assert.equal(saved.pid, a.child.pid);
});

nodeTest(
  "dead actor reclamation excludes a second main through native PID publication",
  async (t) => {
    const { a, b, directory } = await setup(t);
    const inspector = await a.debug();
    const breakpoint = await inspector.before(
      path.join(repo, "src/agent/process.ts"),
      "fs.rmSync(lock, { recursive: true })",
    );
    const first = a.request("ensure");
    const paused = await inspector.pause();
    assert.equal(records(paused.callFrames)[0]?.functionName, "removeObservedLock");
    const old = fs.readFileSync(path.join(directory, "actor.lock/process.json"), "utf8");
    const contender = await b.request("ensure");
    assert.equal(
      contender.ok,
      false,
      "a matched inode is not permission to race another reclaimer",
    );
    assert.match(text(contender.error), /Agent ownership is changing/);
    assert.equal(fs.readFileSync(path.join(directory, "actor.lock/process.json"), "utf8"), old);
    const publication = await inspector.before(
      path.join(repo, "src/agent/process.ts"),
      'write(path.join(dir, "actor.lock", "process.json"),',
    );
    await inspector.resume(breakpoint);
    const publishing = await inspector.pause();
    const frame = records(publishing.callFrames)[0];
    assert.equal(frame?.functionName, "spawnActor");
    const evaluated = await inspector.call("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrameId,
      expression: "pid",
      returnByValue: true,
    });
    assertRecord(evaluated.result);
    const nativePid = evaluated.result.value;
    assert.ok(typeof nativePid === "number" && alive(nativePid));
    a.actors.add(nativePid);
    assert.equal(
      (await b.request("ensure")).ok,
      false,
      "ownership remains exclusive after native spawn and before PID publication",
    );
    await inspector.resume(publication);
    const result = await first;
    assert.equal(result.ok, true);
    assertRecord(result.record);
    assert.equal(result.record.pid, nativePid);
    assert.ok(typeof result.record.pid === "number" && alive(result.record.pid));
    const observed = await b.request("ensure");
    assert.equal(
      observed.ok,
      true,
      "released ownership permits reinspection of the published actor",
    );
    assert.deepEqual(observed.record, result.record);
    assert.equal(new Set([...a.actors, ...b.actors]).size, 1, "one real runner process, not two");
  },
);

nodeTest("native spawn failure releases both the launch claim and ownership lock", async (t) => {
  const { a, b, directory } = await setup(t);
  const failed = await a.request("spawn-failure");
  assert.equal(failed.ok, false);
  assert.match(text(failed.error), /ENOENT/);
  assert.equal(fs.existsSync(path.join(directory, "actor.lock")), false);
  const result = await b.request("ensure");
  assert.equal(result.ok, true, JSON.stringify(result));
  assertRecord(result.record);
  assert.ok(typeof result.record.pid === "number" && alive(result.record.pid));
});

nodeTest(
  "ownership close and process exit release OS locks without replacing the private inode",
  async (t) => {
    const { a, b, base } = await setup(t);
    assert.equal((await a.request("hold")).ok, true);
    const file = path.join(base, "ownership.lock");
    const initial = fs.lstatSync(file);
    assert.equal(initial.mode & 0o777, 0o600);
    assert.equal(
      (await a.request("attach")).ok,
      false,
      "same-process contention closes only its own connection",
    );
    assert.equal((await b.request("attach")).ok, false, "the original native lock is still held");
    assert.equal((await a.request("release")).ok, true);
    assert.equal((await a.request("hold")).ok, true, "close releases the prior transaction");
    assert.equal((await b.request("attach")).ok, false);
    await a.stop();
    assert.equal(
      (await b.request("attach")).ok,
      true,
      "process exit releases the held transaction",
    );
    const current = fs.lstatSync(file);
    assert.equal(current.dev, initial.dev);
    assert.equal(current.ino, initial.ino);
  },
);
