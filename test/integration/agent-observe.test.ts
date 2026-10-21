import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessTerminal, stripTerminalSequences } from "@earendil-works/pi-tui";
import * as sdk from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { nativeSdkRoot } from "../support/native-sdk.ts";
import { record } from "../support/assertions.ts";
import { spy } from "sinon";
import { usageLaunch } from "../support/agent-launch.ts";
import { ownIdentity } from "../../src/agent/process.ts";
import { write } from "../../src/agent/storage.ts";

class CaptureTerminal extends ProcessTerminal {
  output = "";
  input?: (data: string) => void;
  resize?: () => void;
  width = 100;
  height = 32;
  override get columns(): number {
    return this.width;
  }
  override get rows(): number {
    return this.height;
  }
  override start(input: (data: string) => void, resize: () => void): void {
    this.input = input;
    this.resize = resize;
  }
  override stop(): void {
    this.input = undefined;
    this.resize = undefined;
  }
  override write(data: string): void {
    this.output = (this.output + data).slice(-1048576);
  }
  override moveBy(lines: number): void {
    this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
  }
  override hideCursor(): void {
    this.write("\x1b[?25l");
  }
  override showCursor(): void {
    this.write("\x1b[?25h");
  }
  override clearLine(): void {
    this.write("\x1b[K");
  }
  override clearFromCursor(): void {
    this.write("\x1b[J");
  }
  override clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }
  override setTitle(title: string): void {
    this.write(`\x1b]0;${title}\x07`);
  }
  override setProgress(active: boolean): void {
    this.write(`\x1b]9;4;${active ? 3 : 0}\x07`);
  }
  override async drainInput(): Promise<void> {
    return Promise.resolve();
  }
  send(data: string): void {
    this.input?.(data);
  }
  text(): string {
    return stripTerminalSequences(this.output);
  }
  clear(): void {
    this.output = "";
  }
}
async function until(check: () => boolean, reason: string, detail?: () => string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `${reason}\n${detail?.() ?? ""}`);
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}
function requests(root: string): number {
  return fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split("\n").length;
}

function actorExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}
function restoreEnvironment(prior: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
async function cleanupActors(root: string): Promise<void> {
  const file = path.join(root, "sessions.jsonl");
  const entries = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
  const pids = entries
    .map((line) => record(JSON.parse(line)))
    .filter((entry) => entry.child === true)
    .map((entry) => {
      assert.ok(typeof entry.pid === "number");
      return entry.pid;
    });
  await until(
    () => pids.every(actorExited),
    "actual owned native actors exit after attachment shutdown",
  );
  fs.rmSync(root, { recursive: true, force: true });
}

for (const tuiMode of ["fullscreen", "regular"] as const) {
  test(
    `native ${tuiMode} observer watches an actual child without waking or aborting either agent and clears on replacement`,
    { timeout: 45000 },
    async (t) => {
      const sdkRoot = nativeSdkRoot(process.env.PI_SINGLE_AGENT_TEST_SDK);
      const root = fs.mkdtempSync(path.join(process.env.HOME ?? "", "observer-"));
      const agentDir = path.join(root, "agent");
      fs.mkdirSync(agentDir);
      const prior = {
        PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        OBSERVE_TEST_ROOT: process.env.OBSERVE_TEST_ROOT,
        OBSERVE_TEST_CONTEXT: process.env.OBSERVE_TEST_CONTEXT,
      };
      process.env.PI_PACKAGE_DIR = sdkRoot;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.OBSERVE_TEST_ROOT = root;
      process.env.OBSERVE_TEST_CONTEXT = tuiMode === "regular" ? "fork" : "fresh";
      const providerFile = path.resolve("test/fixtures/agent-observe-provider.ts");
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          extensions: [providerFile],
          quietStartup: true,
          theme: "dark",
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      );
      const models = await sdk.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const faux = fauxProvider({
        provider: "observe-fixture",
        models: [{ id: "native-observe", reasoning: false }],
      });
      const services = await sdk.createAgentSessionServices({
        cwd: root,
        agentDir,
        modelRuntime: models,
        settingsManager: sdk.SettingsManager.create(root, agentDir),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noThemes: true,
          noPromptTemplates: true,
          additionalExtensionPaths: [path.resolve("src/index.ts"), providerFile],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const runtime = await sdk.createAgentSessionRuntime(
        async ({ sessionManager }) => ({
          ...(await sdk.createAgentSessionFromServices({
            services,
            sessionManager,
            model: faux.getModel(),
          })),
          services,
          diagnostics: services.diagnostics,
        }),
        {
          cwd: root,
          agentDir,
          sessionManager: sdk.SessionManager.create(root, path.join(root, "sessions")),
        },
      );
      const terminal = new CaptureTerminal();
      const mode = new sdk.InteractiveMode(runtime, {
        terminal,
        tuiMode,
        initialThemeSetting: "dark",
      });
      const work: { prompt?: Promise<void>; disposed: boolean } = { disposed: false };
      t.after(async () => {
        fs.writeFileSync(path.join(root, "release-child"), "release");
        fs.writeFileSync(path.join(root, "release-parent"), "release");
        try {
          await work.prompt;
        } finally {
          try {
            if (!work.disposed) {
              await runtime.dispose();
            }
          } finally {
            mode.stop();
            restoreEnvironment(prior);
            await cleanupActors(root);
          }
        }
      });
      await mode.init();
      await until(() => terminal.text().includes("Agents: 0 active"), "native status appears");
      const emptyCommand = mode.getUserInput().then((text) => runtime.session.prompt(text));
      terminal.send("/agents");
      terminal.send("\r");
      await until(
        () => terminal.text().includes("No child runs"),
        "native command opens empty inventory",
      );
      terminal.send("\x1b");
      await emptyCommand;
      work.prompt = runtime.session.prompt("START_OBSERVE");
      await until(
        () =>
          fs.existsSync(path.join(root, "child-ready")) &&
          fs.existsSync(path.join(root, "parent-ready")),
        "actual provider and child tool are both live",
      );
      const childStart = fs
        .readFileSync(path.join(root, "sessions.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => record(JSON.parse(line)))
        .find((entry) => entry.child === true);
      assert.ok(childStart !== undefined);
      assert.equal(
        childStart.observerCommand,
        false,
        "human command is not registered in native children",
      );
      const base = path.join(
        agentDir,
        "sessions/agent-runs",
        runtime.session.sessionManager.getSessionId(),
      );
      const runId = fs
        .readdirSync(base)
        .find((name) => fs.existsSync(path.join(base, name, "launch.json")));
      assert.ok(runId !== undefined);
      const runDir = path.join(base, runId);
      terminal.clear();
      terminal.send("/agents");
      terminal.send("\r");
      await until(
        () => terminal.text().includes("watch-child") && terminal.text().includes("enter watch"),
        "native key path lists child while parent streams",
      );
      const calls = requests(root);
      terminal.clear();
      terminal.height = 10;
      terminal.resize?.();
      await until(
        () => terminal.text().includes(`> ${runId.slice(0, 8)}`),
        "selected child stays visible in a ten-row terminal",
      );
      terminal.height = 32;
      terminal.resize?.();
      terminal.clear();
      terminal.send("\r");
      await until(
        () =>
          terminal.text().includes("CHILD_TEXT_LIVE") && terminal.text().includes("observe_gate"),
        "published assistant text and pending native tool call appear",
      );
      if (tuiMode === "regular") {
        assert.match(terminal.text(), /Fork context: includes inherited parent activity/);
      }
      terminal.width = 46;
      terminal.resize?.();
      terminal.clear();
      fs.writeFileSync(path.join(root, "release-child"), "release");
      await until(
        () =>
          terminal.text().includes("CHILD_TOOL_ERROR_FACT") &&
          terminal.text().includes("CHILD_FINAL_FACT"),
        "native journal appends update the same watch",
      );
      assert.equal(
        requests(root),
        calls + 1,
        "only the child's post-tool provider request occurred",
      );
      await until(
        () => fs.existsSync(path.join(runDir, "result.json")),
        "canonical completion is published",
      );
      await until(
        () => terminal.text().includes("Agents: 0 active") && terminal.text().includes("completed"),
        "completed messageable actor is not counted as active work",
      );
      const actor = record(
        JSON.parse(fs.readFileSync(path.join(runDir, "actor.lock/process.json"), "utf8")),
      );
      assert.ok(typeof actor.pid === "number");
      process.kill(actor.pid, 0);
      assert.equal(
        runtime.session.isStreaming,
        true,
        "watch input never aborted the active parent",
      );
      terminal.send("\x1b");
      terminal.send("\x1b");
      terminal.clear();
      terminal.send(`/agents ${runId.slice(0, 8)}`);
      terminal.send("\r");
      terminal.width = 60;
      terminal.resize?.();
      await until(
        () => terminal.text().includes("CHILD_FINAL_FACT"),
        "visible unique eight-character prefix opens the child read-only",
        () => terminal.text(),
      );
      assert.match(
        terminal.text(),
        /\.jsonl/,
        "narrow journal paths retain their useful filename suffix",
      );
      assert.equal(requests(root), calls + 1, "direct watching is also non-waking");
      fs.writeFileSync(path.join(root, "release-parent"), "release");
      await work.prompt;
      await runtime.session.waitForIdle();
      terminal.clear();
      const replacement = await runtime.newSession();
      assert.equal(replacement.cancelled, false);
      await until(
        () => terminal.text().includes("Agents: 0 active · 0 runs"),
        "native replacement closes the old watch and rebinds its status",
      );
      const newCommand = mode.getUserInput().then((text) => runtime.session.prompt(text));
      terminal.clear();
      terminal.send("/agents");
      terminal.send("\r");
      await until(
        () => terminal.text().includes("No child runs"),
        "replacement cannot mix previous owner's children",
      );
      assert.equal(runtime.session.isStreaming, false);
      await runtime.dispose();
      work.disposed = true;
      mode.stop();
      await newCommand;
      assert.equal(terminal.input, undefined, "native terminal transport is stopped");
    },
  );
}

test(
  "native observer caches completed metadata, probes each active root once per tick and resolves ambiguity beyond its row cache",
  { timeout: 30000 },
  async (t) => {
    const sdkRoot = nativeSdkRoot(process.env.PI_SINGLE_AGENT_TEST_SDK);
    const root = fs.mkdtempSync(path.join(process.env.HOME ?? "", "observer-cache-"));
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir);
    const prior = {
      PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    process.env.PI_PACKAGE_DIR = sdkRoot;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const manager = sdk.SessionManager.create(root, path.join(root, "sessions"));
    const owner = manager.getSessionId();
    const base = path.join(agentDir, "sessions/agent-runs", owner);
    const identity = { ...ownIdentity(), token: "native-observer-fixture" };
    const publish = (id: string, complete: boolean) => {
      const dir = path.join(base, id);
      fs.mkdirSync(dir, { recursive: true });
      const native = sdk.SessionManager.create(root, dir);
      const file = native.getSessionFile();
      assert.ok(file !== undefined);
      fs.writeFileSync(file, JSON.stringify(native.getHeader()) + "\n");
      const launch = {
        ...usageLaunch(file),
        id,
        rootId: id,
        owner,
        sessionId: native.getSessionId(),
        prompt: "large task ".repeat(15000),
      };
      write(path.join(dir, "launch.json"), launch);
      write(path.join(dir, "actor.lock/process.json"), identity);
      write(path.join(dir, "commands/guidance.json"), {
        id: "guidance",
        runId: id,
        action: "steer",
        prompt: "large guidance ".repeat(15000),
        createdAt: 1,
      });
      fs.writeFileSync(path.join(dir, "output.txt"), "PRIVATE_OUTPUT".repeat(10000));
      if (complete) {
        write(path.join(dir, "result.json"), { id, owner, status: "completed", endedAt: 1 });
      }
      return launch;
    };
    for (let i = 0; i < 80; i++) {
      publish(`completed-${i}`, true);
    }
    const active = publish("active-first", false);
    fs.mkdirSync(path.join(base, "active-second"));
    write(path.join(base, "active-second/launch.json"), {
      ...active,
      id: "active-second",
      rootId: "active-first",
      predecessor: "active-first",
    });
    const models = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({ provider: "observe-fixture", models: [{ id: "native-observe" }] });
    models.registerNativeProvider(faux.provider);
    const services = await sdk.createAgentSessionServices({
      cwd: root,
      agentDir,
      modelRuntime: models,
      settingsManager: sdk.SettingsManager.inMemory({ quietStartup: true, theme: "dark" }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noThemes: true,
        noPromptTemplates: true,
        additionalExtensionPaths: [path.resolve("src/agent/observe.ts")],
      },
    });
    const runtime = await sdk.createAgentSessionRuntime(
      async ({ sessionManager }) => ({
        ...(await sdk.createAgentSessionFromServices({
          services,
          sessionManager,
          model: faux.getModel(),
        })),
        services,
        diagnostics: services.diagnostics,
      }),
      { cwd: root, agentDir, sessionManager: manager },
    );
    const terminal = new CaptureTerminal();
    const mode = new sdk.InteractiveMode(runtime, {
      terminal,
      tuiMode: "fullscreen",
      initialThemeSetting: "dark",
    });
    const opens = spy(fs, "openSync");
    const probes = spy(cp, "execFileSync");
    const scans = spy(fs, "readdirSync");
    syncBuiltinESMExports();
    const opened = () =>
      opens.getCalls().flatMap((call) => {
        const args: readonly unknown[] = call.args;
        return typeof args[0] === "string" ? [args[0]] : [];
      });
    const psCalls = () =>
      probes.getCalls().filter((call) => {
        const args: readonly unknown[] = call.args;
        return args[0] === "ps";
      }).length;
    const scanned = () =>
      scans.getCalls().some((call) => {
        const args: readonly unknown[] = call.args;
        return args[0] === base;
      });
    t.after(async () => {
      try {
        await runtime.dispose();
      } finally {
        mode.stop();
        opens.restore();
        probes.restore();
        scans.restore();
        syncBuiltinESMExports();
        restoreEnvironment(prior);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    await mode.init();
    await until(
      () => terminal.text().includes("Agents: 2 active · 82 runs"),
      "initial owner metadata scan has completed",
    );
    assert.equal(opened().filter((file) => file.endsWith("/launch.json")).length, 82);
    assert.equal(
      psCalls(),
      1,
      "completed live idle actors incur no process probes; active siblings share one root probe",
    );
    opens.resetHistory();
    probes.resetHistory();
    scans.resetHistory();
    await until(scanned, "next actual metadata scan processed the owner inventory");
    const reads = opened();
    assert.ok(
      reads.includes(path.join(base, "active-second/result.json")),
      "completed history never consumes the warm active refresh budget",
    );
    assert.equal(
      reads.filter((file) => file.endsWith("/launch.json")).length,
      0,
      "immutable launch prompts are not re-read",
    );
    assert.equal(
      reads.filter((file) => file.includes("/completed-")).length,
      0,
      "completed metadata and idle actors are cached",
    );
    assert.equal(
      reads.filter((file) => file.includes("/commands/") || file.endsWith("/output.txt")).length,
      0,
      "inventory never reads guidance prompts or output",
    );
    assert.equal(psCalls(), 1, "one actual PID/birth owner lookup per active root per tick");
    write(path.join(base, "active-first/successor.json"), { id: "active-second" });
    opens.resetHistory();
    probes.resetHistory();
    scans.resetHistory();
    await until(scanned, "owner processes the published A-to-B successor on the next scan");
    assert.ok(opened().includes(path.join(base, "active-first/successor.json")));
    assert.equal(
      psCalls(),
      1,
      "only successor B probes its shared live actor; superseded A does not",
    );
    await until(
      () => terminal.text().includes("Agents: 1 active · 82 runs"),
      "missing-result predecessor no longer inherits the successor's liveness",
    );
    write(path.join(base, "active-second/result.json"), {
      id: "active-second",
      owner,
      status: "completed",
      endedAt: 1,
    });
    opens.resetHistory();
    probes.resetHistory();
    scans.resetHistory();
    await until(scanned, "owner processes B's canonical completion on the next scan");
    assert.ok(
      opened().includes(path.join(base, "active-second/result.json")),
      "warm B refresh is not delayed behind 80 completed histories",
    );
    assert.equal(
      opened().filter((file) => file.includes("/active-first/")).length,
      0,
      "immutable superseded A remains cached even without a result",
    );
    assert.equal(psCalls(), 0, "B's live idle actor is not probed after canonical completion");
    await until(
      () => terminal.text().includes("Agents: 0 active · 82 runs"),
      "completed successor cannot make interrupted predecessor look active",
    );
    terminal.clear();
    const retired = mode.getUserInput().then((text) => runtime.session.prompt(text));
    terminal.send("/agents");
    terminal.send("\r");
    await until(
      () =>
        terminal.text().includes("interrupted · active-first") &&
        terminal.text().includes("completed · active-second"),
      "native inventory exposes distinct predecessor and successor outcomes",
    );
    terminal.send("\x1b");
    await retired;
    for (let i = 0; i < 101; i++) {
      publish(`padding-${String(i).padStart(3, "0")}`, true);
    }
    publish("zzprefix-first", true);
    publish("zzprefix-second", true);
    opens.resetHistory();
    terminal.clear();
    const ambiguous = mode.getUserInput().then((text) => runtime.session.prompt(text));
    terminal.send("/agents zzprefix");
    terminal.send("\r");
    await until(
      () => terminal.text().includes("Ambiguous child run prefix"),
      "all canonical IDs, not just the first 50 cached rows, participate in prefix resolution",
    );
    assert.equal(
      opened().filter((file) => file.includes("/zzprefix-")).length,
      0,
      "ambiguity is rejected while both matching rows remain outside the metadata cache",
    );
    terminal.send("\x1b");
    await ambiguous;
    terminal.clear();
    const missing = mode.getUserInput().then((text) => runtime.session.prompt(text));
    terminal.send("/agents missing-run");
    terminal.send("\r");
    await until(
      () => terminal.text().includes("No child run matches that ID"),
      "missing ID has observer-specific, non-launch wording",
    );
    terminal.send("\x1b");
    await missing;
  },
);
