import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { test as nodeTest, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import {
  escalationSchema,
  resultSchema,
  type Escalation,
  type Launch,
  type Result,
} from "../../src/agent/contracts.ts";
import { resolveActiveEscalation } from "../../src/agent/overseer-pause.ts";
import { publishAttachment } from "../../src/agent/attachment.ts";
import { ensureActor, ownIdentity } from "../../src/agent/process.ts";
import { stopRun } from "../../src/agent/shutdown.ts";
import { enqueue, ownerDirectory, read, runDirectory, write } from "../../src/agent/storage.ts";
import { nativeSdkRoot } from "../support/native-sdk.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE_ENTRY = path.join(REPO_ROOT, "test/fixtures/overseer-steer-provider.ts");

async function until<T>(
  readValue: () => T | undefined,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (value !== undefined) {
      return value;
    }
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeGitRepo(t: TestContext): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-int-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "timer.ts"), "export const INTERVAL_MS = 0;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  return repo;
}

async function launchChild(
  t: TestContext,
  options: {
    readonly repo: string;
    readonly prompt: string;
    readonly readOnly?: boolean;
    readonly judge?: string;
    readonly ownerContext?: string;
  },
) {
  const owner = "owner-int";
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-agent-"));
  const base = ownerDirectory(agentDir, owner);
  fs.mkdirSync(base, { recursive: true });
  const skepticLog = path.join(base, "skeptic.log");
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [FIXTURE_ENTRY],
      defaultProjectTrust: "always",
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );

  const prevRepo = process.env.OVERSEER_TEST_REPO;
  const prevLog = process.env.OVERSEER_TEST_SKEPTIC_LOG;
  process.env.OVERSEER_TEST_REPO = options.repo;
  process.env.OVERSEER_TEST_SKEPTIC_LOG = skepticLog;
  t.after(() => {
    if (prevRepo === undefined) {
      delete process.env.OVERSEER_TEST_REPO;
    } else {
      process.env.OVERSEER_TEST_REPO = prevRepo;
    }
    if (prevLog === undefined) {
      delete process.env.OVERSEER_TEST_SKEPTIC_LOG;
    } else {
      process.env.OVERSEER_TEST_SKEPTIC_LOG = prevLog;
    }
  });

  publishAttachment(base, ownIdentity(), randomUUID());
  const id = randomUUID();
  const dir = runDirectory(base, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manager = SessionManager.create(options.repo, dir);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile !== undefined);
  fs.writeFileSync(sessionFile, `${JSON.stringify(manager.getHeader())}\n`, { mode: 0o600 });

  const launch: Launch = {
    version: 1,
    id,
    rootId: id,
    owner: "owner-int",
    cwd: options.repo,
    agentDir,
    sdk: nativeSdkRoot(),
    entry: path.join(REPO_ROOT, "src/agent/index.ts"),
    sessionFile,
    sessionId: manager.getSessionId(),
    prompt: options.prompt,
    context: "fresh",
    provider: "overseer-fixture",
    model: "native-overseer",
    thinking: "off",
    trusted: true,
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.ownerContext !== undefined ? { ownerContext: options.ownerContext } : {}),
    overseer: {
      enabled: true,
      judge: options.judge ?? "overseer-skeptic-fixture/grounded-skeptic",
    },
    createdAt: Date.now(),
  };
  write(path.join(dir, "launch.json"), launch, true);
  enqueue(base, launch, { action: "run" });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    const notices: string[] = [];
    try {
      stopRun(base, launch, undefined, (message) => {
        notices.push(message);
      });
    } catch {
      // Child already stopped or cleaned up.
    }
    await delay(100);
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await ensureActor(base, launch, controller.signal);

  const readEsc = (): Escalation | undefined =>
    read(path.join(dir, "escalation.json"), escalationSchema);
  const readRes = (): Result | undefined => read(path.join(dir, "result.json"), resultSchema);
  const readOut = (): string =>
    fs.existsSync(path.join(dir, "output.txt"))
      ? fs.readFileSync(path.join(dir, "output.txt"), "utf8")
      : "";
  return { base, dir, launch, skepticLog, readEsc, readRes, readOut };
}

nodeTest(
  "readOnly child blocks write tool calls and completes without overseer pauses",
  { timeout: 30_000 },
  async (t) => {
    const repo = makeGitRepo(t);
    const run = await launchChild(t, {
      repo,
      prompt: "READ_ONLY_TRY_WRITE",
      readOnly: true,
    });
    const result = await until(run.readRes, "read-only child completion");
    assert.equal(result.status, "completed");
    assert.equal(run.readOut(), "BLOCKED_AS_EXPECTED");
    assert.equal(fs.existsSync(path.join(repo, "src", "blocked.ts")), false);
  },
);

nodeTest(
  "shape_check pauses on early edits, grounded skeptic flags quoted hunk on pre-ship check, and steer fixes before settle",
  { timeout: 45_000 },
  async (t) => {
    const repo = makeGitRepo(t);
    const run = await launchChild(t, {
      repo,
      prompt: "Implement 60-second timer in src/timer.ts",
      ownerContext: "Owner rule: use a 60-second check interval.",
    });

    // 1. Early shape check pause after touching 2 files.
    const shapeEsc = await until(run.readEsc, "early shape_check pause");
    assert.equal(shapeEsc.kind, "shape_check");
    assert.equal(shapeEsc.since, "launch");
    assert.deepEqual(shapeEsc.changedFiles, ["src/extra.ts", "src/timer.ts"]);
    assert.ok(resolveActiveEscalation(run.base, run.launch, "approved") !== undefined);

    // 2. Child edits timer.ts again with 5*60_000 -> grounded skeptic flags exact hunk before settle.
    const skepticEsc = await until(() => {
      const e = run.readEsc();
      return e !== undefined && e.id !== shapeEsc.id ? e : undefined;
    }, "grounded skeptic pause before settle");
    assert.equal(skepticEsc.kind, "skeptic");
    assert.equal(skepticEsc.since, "checkpoint");
    const findings = skepticEsc.findings ?? [];
    assert.equal(findings.length, 1);
    const [firstFinding] = findings;
    assert.ok(firstFinding !== undefined);
    assert.equal(firstFinding.file, "src/timer.ts");
    assert.equal(firstFinding.excerpt, "export const INTERVAL_MS = 5 * 60_000;");
    assert.ok(
      fs
        .readFileSync(run.skepticLog, "utf8")
        .includes("Owner rule: use a 60-second check interval."),
    );

    // 3. Parent steers with correction -> child updates timer.ts to 60_000 before settling.
    const steer = { id: randomUUID(), prompt: "FIX_INTERVAL_TO_60S" };
    assert.ok(resolveActiveEscalation(run.base, run.launch, "approved", steer) !== undefined);
    enqueue(run.base, run.launch, { action: "steer", prompt: steer.prompt, id: steer.id });

    // 4. Final diff check sees the clean 60_000 fix -> parent approves without prompt -> settles cleanly!
    const finalEsc = await until(() => {
      const e = run.readEsc();
      return e !== undefined && e.id !== skepticEsc.id ? e : undefined;
    }, "final_diff pause after steer");
    assert.equal(finalEsc.kind, "final_diff");
    assert.ok(finalEsc.diffExcerpt.includes("INTERVAL_MS = 60_000"));
    assert.ok(resolveActiveEscalation(run.base, run.launch, "approved") !== undefined);

    const result = await until(run.readRes, "final settled result");
    assert.equal(result.status, "completed");
    assert.equal(run.readOut(), "FIXED_AFTER_FINAL_STEER");
    assert.match(fs.readFileSync(path.join(repo, "src", "timer.ts"), "utf8"), /60_000/u);
  },
);

nodeTest(
  "tool-error loop pauses after 3 consecutive error turns and resumes on steer",
  { timeout: 30_000 },
  async (t) => {
    const repo = makeGitRepo(t);
    const run = await launchChild(t, {
      repo,
      prompt: "TOOL_ERROR_LOOP",
      judge: "off",
    });

    const errEsc = await until(run.readEsc, "tool_errors pause");
    assert.equal(errEsc.kind, "tool_errors");
    assert.equal(errEsc.toolErrorTurns?.length, 3);

    const steer = { id: randomUUID(), prompt: "Stop running failing bash commands and reply." };
    assert.ok(resolveActiveEscalation(run.base, run.launch, "approved", steer) !== undefined);
    enqueue(run.base, run.launch, { action: "steer", prompt: steer.prompt, id: steer.id });

    const result = await until(run.readRes, "completion after error steer");
    assert.equal(result.status, "completed");
    assert.equal(run.readOut(), "RECOVERED_AFTER_ERROR_STEER");
  },
);
