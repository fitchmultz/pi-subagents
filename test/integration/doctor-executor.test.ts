import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createEventBus,
  createTempDir,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import { ASYNC_DIR, CHAIN_RUNS_DIR, RESULTS_DIR, TEMP_ROOT_DIR } from "../../src/shared/types.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const importHome = createTempDir("pi-doctor-executor-import-home-");
process.env.HOME = importHome;
process.env.USERPROFILE = importHome;
let createSubagentExecutor: typeof import("../../src/runs/foreground/subagent-executor.ts").createSubagentExecutor;
try {
  ({ createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts"));
} finally {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  removeTempDir(importHome);
}

function makeState(cwd: string) {
  return {
    baseCwd: cwd,
    currentSessionId: null,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

describe("doctor action executor routing", () => {
  let tempDir = "";
  let tempHome = "";

  beforeEach(() => {
    tempDir = createTempDir("pi-doctor-executor-project-");
    tempHome = createTempDir("pi-doctor-executor-home-");
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.PI_CODING_AGENT_DIR = path.join(tempHome, ".pi", "agent");
    for (const dir of [ASYNC_DIR, RESULTS_DIR, CHAIN_RUNS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    for (const dir of [ASYNC_DIR, RESULTS_DIR, CHAIN_RUNS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    removeTempDir(tempDir);
    removeTempDir(tempHome);
  });

  it("returns a doctor report for the tool action", async () => {
    const sessionFile = path.join(tempDir, "sessions", "parent.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "");
    const write = (file: string, contents: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    };
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    for (const [dir, names] of [
      [path.join(agentDir, "agents"), ["user-a"]],
      [path.join(tempDir, ".pi", "agents"), ["project-a", "project-b"]],
    ] as const) {
      for (const name of names) {
        write(
          path.join(dir, `${name}.md`),
          `---\nname: ${name}\ndescription: Fixture agent\n---\nFixture instructions`,
        );
      }
    }
    write(
      path.join(agentDir, "chains", "user-flow.chain.md"),
      "---\nname: user-flow\ndescription: User chain\n---\n\n## worker\n\nUser work",
    );
    write(
      path.join(tempDir, ".pi", "chains", "project-flow.chain.md"),
      "---\nname: project-flow\ndescription: Project chain\n---\n\n## worker\n\nProject work",
    );
    write(
      path.join(tempDir, ".pi", "skills", "project-skill", "SKILL.md"),
      "---\nname: project-skill\ndescription: Project skill\n---\nFixture skill",
    );
    const packageDir = path.join(agentDir, "package");
    write(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-skills",
        pi: { skills: ["./skills"] },
        subagents: { agents: ["profiles"] },
      }),
    );
    write(
      path.join(packageDir, "profiles", "package-agent.md"),
      "---\nname: package-agent\ndescription: Package agent\n---\nPackage instructions",
    );
    write(
      path.join(packageDir, "skills", "package-skill", "SKILL.md"),
      "---\nname: package-skill\ndescription: Package skill\n---\nFixture skill",
    );
    write(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["./package"] }));
    const executor = createSubagentExecutor({
      pi: { events: createEventBus(), getSessionName: () => undefined },
      state: makeState(tempDir),
      config: { defaultSessionDir: path.join(tempDir, "configured-sessions") },
      asyncByDefault: false,
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (value: string) => value,
      discoverAgents: () => ({ agents: [] }),
    });
    const ctx = makeMinimalCtx(tempDir);
    ctx.sessionManager.getSessionFile = () => sessionFile;
    ctx.sessionManager.getSessionId = () => "session-doctor";

    const result = await executor.execute(
      "doctor-id",
      { action: "doctor" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.isError, undefined);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /^Subagents doctor report/);
    assert.ok(text.includes(`- Native session cwd: ${tempDir}`));
    assert.ok(text.includes(`- current session file: ${sessionFile}`));
    assert.match(text, /- current session id: session-doctor/);
    assert.match(text, /- async support: available \(Node >=24\)/);
    assert.ok(text.includes(`- temp root: ok (${TEMP_ROOT_DIR})`));
    assert.ok(text.includes(`- async runs: ok (${ASYNC_DIR})`));
    assert.ok(text.includes(`- results: ok (${RESULTS_DIR})`));
    assert.ok(text.includes(`- chain runs: ok (${CHAIN_RUNS_DIR})`));
    assert.match(text, /- agents: total 21 \(builtin 17, package 1, user 1, project 2\)/);
    assert.match(text, /- chains: total 2 \(builtin 0, package 0, user 1, project 1\)/);
    assert.match(text, /- skills: total 2 \(project 1, user-package 1\)/);
    assert.match(text, /- configured session dir: .*configured-sessions/);
    assert.match(text, /- connection: unknown/);
    assert.match(text, /- bridge: unavailable/);
    assert.match(text, /- orchestrator target:/);
  });

  for (const connection of [
    "connected",
    "disconnected",
    "connecting",
    "unknown",
    "unavailable",
  ] as const) {
    it(`reports ${connection} from the live bridge, not the routing name`, async () => {
      const events = createEventBus();
      let requests = 0;
      if (connection !== "unavailable")
        events.on("subagent:intercom-health-request", (payload) => {
          requests++;
          const { requestId } = payload as { requestId: string };
          events.emit("subagent:intercom-health-response", {
            requestId,
            health: [],
            connection: {
              status: connection,
              ...(connection === "connected" ? { sessionId: "registered-parent" } : {}),
            },
          });
        });
      const executor = createSubagentExecutor({
        pi: { events, getSessionName: () => "looks-connected" },
        state: makeState(tempDir),
        config: {},
        asyncByDefault: false,
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value) => value,
        discoverAgents: () => ({ agents: [] }),
      });
      const started = performance.now();
      const result = await executor.execute(
        "doctor",
        { action: "doctor" },
        undefined,
        undefined,
        makeMinimalCtx(tempDir),
      );
      const text = result.content[0]?.text ?? "";
      assert.equal(result.isError, undefined);
      assert.ok(
        performance.now() - started < 2_000,
        "an unavailable bridge must not block diagnostics",
      );
      assert.match(
        text,
        new RegExp(`- connection: ${connection === "unavailable" ? "unknown" : connection}`),
      );
      assert.match(
        text,
        new RegExp(`- bridge: ${connection === "unavailable" ? "unavailable" : "responding"}`),
      );
      assert.equal(requests, connection === "unavailable" ? 0 : 1);
      assert.match(
        text,
        new RegExp(
          `- broker session id: ${connection === "connected" ? "registered-parent" : "not available"}`,
        ),
      );
      assert.ok(text.includes(`- Node: ${process.version}`));
      assert.ok(text.includes(`- process: ${process.pid} (${process.execPath})`));
      assert.match(text, /- loaded Pi version: \S+/);
      assert.match(text, /- Pi package directory:/);
      assert.match(text, /- native queue contract: not verified/);
      assert.match(text, /- loaded pi-subagents build: unknown \(unbuilt source\)/);
      assert.doesNotMatch(text, /wiring: active/);
    });
  }

  it("captures the directory owner once before awaiting live discovery", async () => {
    const events = createEventBus();
    const selected = path.join(tempDir, "selected");
    fs.mkdirSync(selected);
    let current = selected;
    let resolutions = 0;
    events.on("pi-change-working-dir:resolve-execution-cwd", (request) => {
      resolutions++;
      request.result = { cwd: current };
    });
    events.on("subagent:intercom-health-request", ({ requestId }) => {
      queueMicrotask(() => {
        current = tempDir;
        events.emit("subagent:intercom-health-response", {
          requestId,
          health: [],
          connection: { status: "disconnected" },
        });
      });
    });
    const executor = createSubagentExecutor({
      pi: { events, getSessionName: () => undefined },
      state: makeState(tempDir),
      config: {},
      asyncByDefault: false,
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (value) => value,
      discoverAgents: () => ({ agents: [] }),
    });
    const pending = executor.execute(
      "doctor",
      { action: "doctor" },
      undefined,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(resolutions, 1, "resolve synchronously before the first await");
    const result = await pending;
    assert.ok(result.content[0].text.includes(`- Requested cwd: ${selected}`));
    assert.equal(resolutions, 1);
  });

  it("reports session, storage and selected-settings failures without failing the doctor action", async () => {
    for (const dir of [ASYNC_DIR, RESULTS_DIR, CHAIN_RUNS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.writeFileSync(ASYNC_DIR, "not a directory");
    const executor = createSubagentExecutor({
      pi: { events: createEventBus(), getSessionName: () => undefined },
      state: makeState(tempDir),
      config: {},
      asyncByDefault: false,
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (value: string) => value,
      discoverAgents: () => ({ agents: [] }),
    });
    const ctx = makeMinimalCtx(tempDir);
    ctx.sessionManager.getSessionFile = () => {
      throw new Error("session unavailable");
    };
    ctx.sessionManager.getSessionId = () => {
      throw new Error("session unavailable");
    };

    const result = await executor.execute(
      "doctor-id",
      { action: "doctor" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.isError, undefined);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /^Subagents doctor report/);
    assert.match(text, /- session manager: failed — Error: session unavailable/);
    assert.match(text, /- current session file: not available/);
    assert.match(text, /- async support: available \(Node >=24\)/);
    assert.match(text, /- async runs: failed .*Error: not a directory:/);
    assert.match(text, /- results: missing /);
    assert.match(text, /- chain runs: missing /);
    assert.match(text, /- skills: total 0 \(none\)/);
    assert.match(text, /- connection: unknown/);
    assert.match(text, /- bridge: unavailable/);
    assert.match(text, /- orchestrator target: not available/);
    const malformedDir = path.join(tempDir, "malformed");
    fs.mkdirSync(path.join(malformedDir, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(path.join(malformedDir, ".pi", "settings.json"), "{bad-json");
    const malformed = await executor.execute(
      "doctor-malformed",
      { action: "doctor", cwd: malformedDir },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(malformed.isError, undefined);
    const diagnostics = malformed.content[0]?.text ?? "";
    assert.match(diagnostics, /- agents\/chains: failed — Error: Failed to parse settings file/);
    assert.match(diagnostics, /- skills: failed — Error: Failed to read skills settings file/);
    assert.match(diagnostics, /- temp root: ok /);
    assert.match(diagnostics, /- connection: unknown/);
  });
});
