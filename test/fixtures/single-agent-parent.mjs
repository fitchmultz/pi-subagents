import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findPackageJSON, syncBuiltinESMExports } from "node:module";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const [root, repo, sdkRoot, phase] = process.argv.slice(2);
const cwd = path.join(root, "project"),
  agentDir = path.join(root, "agent");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_") || key === "NODE_OPTIONS") {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: agentDir,
  PI_PACKAGE_DIR: sdkRoot,
  SINGLE_AGENT_TEST_ROOT: root,
  PI_OFFLINE: "1",
  PI_INTERCOM_RUNTIME_DIR: path.join(root, "ic"),
  PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"),
});
for (const directory of [cwd, agentDir, path.join(cwd, ".pi/agents")]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(cwd, "AGENTS.md"), "NATIVE_PROJECT_INSTRUCTION_4289\n");
fs.writeFileSync(
  path.join(cwd, ".pi/agents/default.md"),
  "---\nname: default\n---\nOBSOLETE_PROFILE_BODY\n",
);
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  JSON.stringify({
    extensions: [path.join(repo, "test/fixtures/single-agent-provider.mjs")],
    defaultProjectTrust: "always",
    retry: { enabled: false },
    compaction: { enabled: false },
  }),
);
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const aiRoot = path.dirname(
  findPackageJSON("@earendil-works/pi-ai", pathToFileURL(path.join(sdkRoot, "dist/index.js"))),
);
const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } = await import(
  pathToFileURL(path.join(aiRoot, "dist/index.js")).href
);
const { default: agents } = await import(
  pathToFileURL(path.join(repo, "dist/agent/index.js")).href
);
const seedFile = path.join(root, "seed.json");
const seed = fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile, "utf8")) : undefined;
function parentManager() {
  if (phase === "foreign") {
    return sdk.SessionManager.create(cwd, path.join(root, "parent-sessions"));
  }
  if (phase === "fork-owner") {
    return sdk.SessionManager.forkFrom(seed.sessionFile, cwd, path.join(root, "fork-sessions"));
  }
  if (seed) {
    return sdk.SessionManager.open(seed.sessionFile);
  }
  return sdk.SessionManager.create(cwd, path.join(root, "parent-sessions"));
}
const manager = parentManager();
const faux = fauxProvider({
  provider: "single-agent-parent",
  models: [{ id: "parent-model", reasoning: true }],
});
const models = await sdk.ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
models.registerNativeProvider(faux.provider);
models.registerNativeProvider(
  fauxProvider({
    provider: "single-agent-fixture",
    models: [{ id: "literal-model", reasoning: true }],
  }).provider,
);
faux.setResponses([fauxAssistantMessage("PARENT_STARTUP_LITERAL")]);
const errors = [];
let networkRequests = 0;
globalThis.fetch = async () => {
  networkRequests++;
  throw new Error("No network allowed");
};
if (phase.startsWith("crash-")) {
  const append = manager.appendCustomMessageEntry.bind(manager);
  manager.appendCustomMessageEntry = (type, ...args) => {
    if (type !== "agent-completion") {
      return append(type, ...args);
    }
    if (phase === "crash-after") {
      append(type, ...args);
    }
    fs.writeFileSync(
      path.join(root, `${phase}.json`),
      JSON.stringify({ entries: manager.getEntries() }),
    );
    process.kill(process.pid, "SIGKILL");
  };
}
const settings = sdk.SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
  // Native peekQueuedMessages previews only the next turn's selected messages.
  ...(phase === "queue-retain" ? { steeringMode: "all" } : {}),
});
settings.setProjectTrusted(true);
let cwdOwner;
if (phase === "cwd" || phase === "cwd-reopen" || phase.startsWith("cwd-invalid-")) {
  const source =
    process.env.SINGLE_AGENT_CWD_OWNER ??
    path.join(repo, "test/fixtures/native-execution-cwd-owner.ts");
  cwdOwner = path.join(root, "pi-change-working-dir/index.mjs");
  fs.mkdirSync(path.dirname(cwdOwner), { recursive: true });
  const invalid = phase.replace("cwd-invalid-", "");
  if (phase.startsWith("cwd-invalid-")) {
    fs.writeFileSync(
      cwdOwner,
      `
      export default function(pi) {
        let ctx; pi.on('session_start',(_,c)=>{ctx=c;});
        pi.registerCommand('cwd',{handler:async()=>{}});
        for(const event of ['resolve','set']) pi.events.on('pi-change-working-dir:'+event+'-execution-cwd',r=>{
          if(!ctx || r.sessionManager!==ctx.sessionManager || ${JSON.stringify(invalid)}==='missing-resolver' || ${JSON.stringify(invalid)}==='wrong-owner') return;
          if(event==='set' && ${JSON.stringify(invalid)}==='missing-setter') return;
          r.result={cwd:ctx.cwd,...(${JSON.stringify(invalid)}==='error'?{error:'CWD_OWNER_CONTROLLED_ERROR'}:{})};
          if(event==='set' && ${JSON.stringify(invalid)}!=='wrong-directory') r.result={cwd:r.path};
          if(event==='set' && ${JSON.stringify(invalid)}==='wrong-directory') r.result={cwd:${JSON.stringify(cwd)}};
        });
      }
    `,
    );
  } else if (process.env.SINGLE_AGENT_CWD_OWNER) {
    cwdOwner = source;
  } else {
    fs.writeFileSync(
      cwdOwner,
      `
      import owner from ${JSON.stringify(pathToFileURL(source).href)};
      export default function(pi) {
        owner(pi);
        pi.on('tool_call',(event,ctx)=>{
          if(event.toolName!=='bash') return;
          const r={sessionManager:ctx.sessionManager};
          pi.events.emit('pi-change-working-dir:resolve-execution-cwd',r);
          event.input.command='cd '+JSON.stringify(r.result.cwd)+'\\n'+event.input.command;
        });
      }
    `,
    );
  }
  const file = path.join(agentDir, "settings.json"),
    configured = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...configured, extensions: [...configured.extensions, cwdOwner] }),
  );
}
let agentAPI;
let publishLegacyAtSettlement;
const toolEnds = [];
const services = await sdk.createAgentSessionServices({
  cwd,
  agentDir,
  settingsManager: settings,
  modelRuntime: models,
  resourceLoaderOptions: {
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) => {
        agentAPI = pi;
        pi.on("agent_settled", () => publishLegacyAtSettlement?.());
        agents(pi);
        pi.on("tool_execution_end", (event) => {
          toolEnds.push(structuredClone(event));
        });
      },
    ],
    additionalExtensionPaths: cwdOwner ? [cwdOwner] : [],
  },
});
const loader = services.resourceLoader;
assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await sdk.createAgentSessionRuntime(
  async ({ sessionManager }) => ({
    ...(await sdk.createAgentSessionFromServices({
      services,
      sessionManager,
      model: faux.getModel(),
      thinkingLevel: "high",
    })),
    services,
    diagnostics: services.diagnostics,
  }),
  {
    cwd,
    agentDir,
    sessionManager: manager,
  },
);
const { session } = runtime;
await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
const until = async (predicate, why) => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, why);
    // Poll an actual native/filesystem publication, never elapsed time as proof.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
};
const requests = () =>
  fs.existsSync(path.join(root, "requests.jsonl"))
    ? fs
        .readFileSync(path.join(root, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
const resultEntries = (id) =>
  manager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === id,
    );
const notices = () =>
  manager
    .getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "agent-completion");
const call = async (name, args, id) => {
  faux.setResponses([
    fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args }], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("PARENT_LITERAL_FINISHED"),
  ]);
  await session.prompt(`Fixture native tool invocation ${id}`);
  await session.waitForIdle();
  assert.equal(resultEntries(id).length, 1);
  return resultEntries(id)[0].message;
};
const runDir = (id) => path.join(agentDir, "sessions/agent-runs", manager.getSessionId(), id);
const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
let runId = seed?.runId;
try {
  if (phase.startsWith("launch-preparation-")) {
    const faultFile = path.join(root, "preparation-fault.json");
    if (phase !== "launch-preparation-reopen") {
      const receipt = await call(
        "delegate",
        { prompt: "HOLD:first", model: "single-agent-fixture/literal-model" },
        "preparation-valid-launch",
      );
      assert.equal(receipt.isError, false, JSON.stringify(receipt));
      runId = receipt.details.id;
      await until(
        () => requests().some((request) => request.prompt === "HOLD:first"),
        "valid child reaches the actual native provider before preparation fails",
      );
      fs.writeFileSync(
        seedFile,
        JSON.stringify({
          runId,
          sessionId: manager.getSessionId(),
          sessionFile: manager.getSessionFile(),
          childPid: requests().find((request) => request.prompt === "HOLD:first").pid,
        }),
      );
      const writeFile = fs.writeFileSync;
      const base = path.dirname(runDir(runId));
      let faults = 0;
      fs.writeFileSync = (file, body, options) => {
        if (
          typeof file === "string" &&
          file.startsWith(base + path.sep) &&
          file.endsWith(".jsonl") &&
          options?.flag === "wx" &&
          faults === 0
        ) {
          faults++;
          const header = JSON.parse(body.split("\n")[0]);
          assert.equal(header.type, "session");
          assert.equal(header.cwd, cwd);
          assert.notEqual(header.id, manager.getSessionId());
          // Fail the real prepared native session write after partial filesystem progress.
          const retained = phase === "launch-preparation-fork-failure" ? body : body.slice(0, 17);
          writeFile(file, retained, options);
          writeFile(faultFile, JSON.stringify({ file, retained }));
          if (phase === "launch-preparation-crash") {
            process.kill(process.pid, "SIGKILL");
          }
          throw Object.assign(new Error("CONTROLLED_NATIVE_PREPARATION_EIO"), { code: "EIO" });
        }
        return writeFile(file, body, options);
      };
      syncBuiltinESMExports();
      try {
        const failed = await call(
          "delegate",
          {
            prompt: "PREPARATION_MUST_NOT_LAUNCH",
            model: "single-agent-fixture/literal-model",
            context: phase === "launch-preparation-fork-failure" ? "fork" : "fresh",
          },
          "preparation-failed-launch",
        );
        assert.equal(failed.isError, true, JSON.stringify(failed));
        assert.match(JSON.stringify(failed.content), /CONTROLLED_NATIVE_PREPARATION_EIO/);
        assert.equal(faults, 1, "fault reached the actual native session write");
      } finally {
        fs.writeFileSync = writeFile;
        syncBuiltinESMExports();
      }
    }
    const failedDirectory = path.dirname(readJSON(faultFile).file);
    assert.equal(fs.existsSync(failedDirectory), true, "unpublished native journals are retained");
    assert.equal(fs.existsSync(path.join(failedDirectory, "launch.json")), false);
    assert.equal(fs.existsSync(path.join(failedDirectory, "commands")), false);
    assert.equal(fs.existsSync(path.join(failedDirectory, "actor.lock")), false);
    assert.equal(
      fs.readFileSync(readJSON(faultFile).file, "utf8"),
      readJSON(faultFile).retained,
      "preparation errors retain exact native filesystem evidence, including torn writes",
    );
    if (phase === "launch-preparation-fork-failure") {
      const journal = readJSON(faultFile).retained.trim().split("\n").map(JSON.parse);
      assert.equal(journal[0].parentSession, manager.getSessionFile());
      assert.ok(journal.length > 1, "the unpublished fork includes inherited native entries");
      assert.ok(
        journal.some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
        "the retained native branch includes prior tool evidence",
      );
    }
    await session.waitForIdle();
    const listed = await call("agent_runs", { action: "list" }, "preparation-list-valid");
    assert.equal(listed.isError, false, JSON.stringify(listed));
    assert.deepEqual(
      listed.details.runs.map((run) => run.id),
      [runId],
    );
    faux.setResponses([fauxAssistantMessage("PREPARATION_COMPLETION_PROCESSED")]);
    fs.writeFileSync(path.join(root, "release-first"), "release");
    await until(
      () => notices().some((notice) => notice.details.id === runId),
      "valid native completion still reaches the journal despite failed preparation",
    );
    await session.waitForIdle();
    assert.equal(notices().length, 1);
    assert.match(notices()[0].content, /CHILD_LITERAL_RESULT:HOLD:first/);
    const completed = await call("agent_runs", { action: "list" }, "preparation-list-completed");
    assert.equal(completed.isError, false, JSON.stringify(completed));
    assert.equal(completed.details.runs[0].completed, true);
    const sibling = await call(
      "delegate",
      {
        prompt: "PREPARATION_RECOVERY_LITERAL",
        model: "single-agent-fixture/literal-model",
        async: false,
      },
      "preparation-recovery-launch",
    );
    assert.equal(sibling.isError, false, JSON.stringify(sibling));
    assert.equal(sibling.details.output.text, "CHILD_LITERAL_RESULT:PREPARATION_RECOVERY_LITERAL");
    assert.deepEqual(
      requests().map((request) => request.prompt),
      ["HOLD:first", "PREPARATION_RECOVERY_LITERAL"],
      "actual provider completion establishes that the failed launch dispatched no child",
    );
    const starts = fs
      .readFileSync(path.join(root, "native-actor-starts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      starts.map((start) => start.sessionId).sort(),
      [completed.details.runs[0].sessionId, sibling.details.sessionId].sort(),
      "only the admitted valid run and recovery sibling initialized native actors",
    );
    const launchFile = path.join(runDir(runId), "launch.json");
    const originalLaunch = fs.readFileSync(launchFile);
    try {
      fs.writeFileSync(launchFile, "{}");
      const corrupted = await call("agent_runs", { action: "list" }, "preparation-invalid-launch");
      assert.equal(corrupted.isError, true, "an existing invalid canonical launch is not hidden");
    } finally {
      fs.writeFileSync(launchFile, originalLaunch);
    }
  } else if (phase === "inventory") {
    const saved = [];
    for (let index = 0; index < 51; index++) {
      const id = `inventory-${index}`;
      fs.mkdirSync(runDir(id), { recursive: true });
      const launch = {
        version: 1,
        id,
        rootId: index < 50 ? "inventory-0" : id,
        ...(index > 0 && index < 50 ? { predecessor: `inventory-${index - 1}` } : {}),
        owner: manager.getSessionId(),
        cwd,
        agentDir,
        sdk: sdkRoot,
        entry: path.join(repo, "dist/index.js"),
        sessionFile: path.join(runDir(index < 50 ? "inventory-0" : id), "native.jsonl"),
        sessionId: index < 50 ? "native-inventory-0" : `native-${id}`,
        prompt: "SAVED_INVENTORY",
        context: "fresh",
        provider: "single-agent-fixture",
        model: "literal-model",
        thinking: "high",
        trusted: true,
        createdAt: index,
      };
      saved.push(launch);
      fs.writeFileSync(path.join(runDir(id), "launch.json"), JSON.stringify(launch));
      if (index > 0 && index < 50) {
        fs.writeFileSync(
          path.join(runDir(`inventory-${index - 1}`), "successor.json"),
          JSON.stringify({ id }),
        );
      }
      fs.writeFileSync(
        path.join(runDir(id), "result.json"),
        JSON.stringify({
          id,
          owner: manager.getSessionId(),
          status: "completed",
          endedAt: index,
          contributions: [],
        }),
      );
      fs.writeFileSync(
        path.join(runDir(id), "output.txt"),
        `INVENTORY_OUTPUT_${index}:` + "x".repeat(32768),
      );
      manager.appendCustomMessageEntry("agent-completion", "already collected", false, {
        id,
        owner: manager.getSessionId(),
        completed: true,
      });
    }
    const commands = path.join(runDir("inventory-0"), "commands");
    const admissions = path.join(runDir("inventory-0"), "admissions");
    fs.mkdirSync(commands);
    fs.mkdirSync(admissions);
    const expectedGuidance = new Map();
    for (let index = 0; index < 100; index++) {
      const id = `guidance-${index}`,
        guidanceRunId = `inventory-${Math.floor(index / 2)}`;
      const state = ["pending", "accepted", "stale"][index % 3];
      fs.writeFileSync(
        path.join(commands, `${id}.json`),
        JSON.stringify({
          // Metadata must still be found after a large, discarded prompt.
          prompt: "GUIDANCE_PROMPT_MUST_NOT_APPEAR:" + "x".repeat(256 * 1024),
          id,
          runId: guidanceRunId,
          action: "steer",
          createdAt: index,
        }),
      );
      if (state !== "pending") {
        fs.writeFileSync(
          path.join(admissions, `${id}.json`),
          JSON.stringify({ id, runId: guidanceRunId, action: "steer", state, at: index }),
        );
      }
      const guidance = expectedGuidance.get(guidanceRunId) ?? [];
      guidance.unshift({ id, runId: guidanceRunId, action: "steer", state, at: index });
      expectedGuidance.set(guidanceRunId, guidance);
    }
    const original = {
      open: fs.openSync,
      read: fs.readSync,
      close: fs.closeSync,
      readdir: fs.readdirSync,
    };
    const commandDescriptors = new Set();
    const io = { scans: 0, opens: 0, reads: 0, bytes: 0, maxReadBytes: 0 };
    fs.readdirSync = (directory, ...args) => {
      if (directory === commands) {
        io.scans++;
      }
      return original.readdir(directory, ...args);
    };
    fs.openSync = (file, ...args) => {
      const fd = original.open(file, ...args);
      if (typeof file === "string" && path.dirname(file) === commands) {
        commandDescriptors.add(fd);
        io.opens++;
      }
      return fd;
    };
    fs.readSync = (fd, ...args) => {
      const bytes = original.read(fd, ...args);
      if (commandDescriptors.has(fd)) {
        io.reads++;
        io.bytes += bytes;
        io.maxReadBytes = Math.max(io.maxReadBytes, bytes);
      }
      return bytes;
    };
    fs.closeSync = (fd) => {
      commandDescriptors.delete(fd);
      return original.close(fd);
    };
    syncBuiltinESMExports();
    let inventory;
    try {
      inventory = await call("agent_runs", { action: "list" }, "bounded-inventory");
    } finally {
      Object.assign(fs, {
        openSync: original.open,
        readSync: original.read,
        closeSync: original.close,
        readdirSync: original.readdir,
      });
      syncBuiltinESMExports();
    }
    console.log("inventory command I/O:", JSON.stringify(io));
    assert.equal(io.scans, 1, "one shared conversation scan, not one per continuation");
    assert.equal(io.opens, 100, "each guidance record is opened once for the entire page");
    assert.ok(io.reads <= 600, `bounded command read calls: ${io.reads}`);
    assert.ok(io.maxReadBytes <= 64 * 1024, `bounded individual reads: ${io.maxReadBytes}`);
    assert.ok(io.bytes >= 100 * 256 * 1024, "the actual large command spool was read");
    assert.ok(io.bytes < 100 * (256 * 1024 + 1024), `command bytes read: ${io.bytes}`);
    const text = inventory.content.map((block) => block.text ?? "").join("\n");
    assert.ok(
      Buffer.byteLength(text) < 100 * 1024,
      `metadata inventory was ${Buffer.byteLength(text)} bytes`,
    );
    const page = JSON.parse(text);
    assert.equal(page.total, 51);
    assert.equal(page.runs.length, 50);
    assert.equal(page.nextOffset, 50);
    assert.deepEqual(
      page.runs.map((run) => run.id),
      saved.slice(0, 50).map((run) => run.id),
    );
    assert.equal(
      page.runs.every((run) => !("output" in run)),
      true,
      "list never embeds output pages",
    );
    assert.equal(text.includes("INVENTORY_OUTPUT_"), false);
    assert.equal(text.includes("GUIDANCE_PROMPT_MUST_NOT_APPEAR:"), false);
    assert.deepEqual(
      page.runs.map((run) => run.guidance),
      Array.from({ length: 50 }, (_, index) => expectedGuidance.get(`inventory-${index}`)),
      "model-visible metadata preserves pending, accepted and stale guidance for each run",
    );
    const last = await call("agent_runs", { action: "list", offset: 50 }, "inventory-next-page");
    assert.deepEqual(
      last.details.runs.map((run) => run.id),
      ["inventory-50"],
    );
    assert.equal(last.details.nextOffset, undefined);
    const inspected = await call(
      "agent_runs",
      { action: "inspect", id: "inventory-0", length: 32 },
      "inventory-explicit-inspect",
    );
    assert.equal(inspected.details.output.text, "INVENTORY_OUTPUT_0:" + "x".repeat(13));
    assert.equal(inspected.details.output.nextOffset, 32);
    for (const guidance of expectedGuidance.get("inventory-0")) {
      assert.ok(
        inspected.content.some((block) =>
          block.text?.includes(`${guidance.id}: ${guidance.state}`),
        ),
      );
    }
  } else if (phase === "seed" || phase === "receipt") {
    const prompt = "HOLD:first\n  EXACT untouched prompt Ω\n";
    const receipt = await call(
      "delegate",
      { prompt, model: "single-agent-fixture/literal-model" },
      "launch-original",
    );
    assert.equal(receipt.isError, false, JSON.stringify(receipt));
    assert.equal(receipt.details.receipt, "launch");
    runId = receipt.details.id;
    await until(
      () => requests().some((request) => request.prompt === prompt),
      "actual child native provider starts",
    );
    assert.equal(fs.existsSync(path.join(runDir(runId), "result.json")), false);
    assert.equal(receipt.details.completed, false);
    const observedRequest = requests().find((request) => request.prompt === prompt);
    assert.equal(observedRequest.root, manager.getSessionId());
    assert.equal(observedRequest.parent, manager.getSessionId());
    const nativeContext = JSON.stringify(observedRequest.context);
    assert.match(nativeContext, /NATIVE_PROJECT_INSTRUCTION_4289/);
    assert.doesNotMatch(nativeContext, /OBSOLETE_PROFILE_BODY|<subagent_role>|<task>/);
    fs.writeFileSync(
      seedFile,
      JSON.stringify({
        runId,
        sessionFile: manager.getSessionFile(),
        sessionId: manager.getSessionId(),
        pid: process.pid,
        childPid: observedRequest.pid,
      }),
    );
    if (phase === "receipt") {
      faux.setResponses([fauxAssistantMessage("NOTIFICATION_PROCESSED")]);
      fs.writeFileSync(path.join(root, "release-first"), "release");
      await until(() => notices().length === 1, "actual native completion publishes");
      await session.waitForIdle();
      assert.match(notices()[0].content, /CHILD_LITERAL_RESULT:HOLD:first/);
      assert.equal(resultEntries("launch-original").length, 1);
      assert.equal(session.getSessionStats().cost, 0);
      const inspection = await call(
        "agent_runs",
        { action: "inspect", id: runId },
        "inspect-complete",
      );
      assert.equal(
        inspection.details.process.live,
        true,
        "idle actor stays messageable while main attached",
      );
    }
  } else if (phase.startsWith("crash-")) {
    faux.setResponses([fauxAssistantMessage("RECOVERY_NOTIFICATION")]);
    await until(() => false, "must die at actual native append boundary");
  } else if (phase === "resume" || phase === "reopen") {
    assert.notEqual(process.pid, seed.pid);
    faux.setResponses([fauxAssistantMessage("RECOVERY_NOTIFICATION")]);
    await until(() => notices().length === 1, "fresh native parent receives canonical completion");
    await session.waitForIdle();
    assert.equal(resultEntries("launch-original").length, 1);
    assert.match(notices()[0].content, /CHILD_LITERAL_RESULT:HOLD:first/);
    const inspection = await call(
      "agent_runs",
      { action: "inspect", id: runId },
      `inspect-${phase}`,
    );
    assert.equal(inspection.details.completed, true);
    assert.equal(inspection.details.nativeReceipt, notices()[0].id);
    assert.equal(
      requests().filter((request) => request.prompt?.startsWith("HOLD:first")).length,
      1,
    );
  } else if (phase === "bash-before-registration") {
    const prefixReady = path.join(root, "prefix-shell.pid"),
      release = path.join(root, "release-prefix");
    fs.writeFileSync(
      path.join(root, "ticker.mjs"),
      `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(root, "original-work-started"))},'started');setInterval(()=>{},1000);`,
    );
    const file = path.join(agentDir, "settings.json"),
      configured = readJSON(file);
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...configured,
        shellCommandPrefix: `echo $$ > ${JSON.stringify(prefixReady)}; while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.01; done;`,
      }),
    );
    const launched = await call(
      "delegate",
      {
        prompt: "BASH_HOLD_LITERAL",
        model: "single-agent-fixture/literal-model",
      },
      "prefix-held-launch",
    );
    const id = launched.details.id;
    await until(() => fs.existsSync(prefixReady), "actual native shell enters configured prefix");
    const pid = Number(fs.readFileSync(prefixReady, "utf8"));
    const actorPid = requests()[0].pid;
    process.kill(actorPid, "SIGKILL");
    const dead = (target) => {
      try {
        process.kill(target, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    };
    await until(() => dead(actorPid), "actor actually dies before recorder execution");
    try {
      fs.writeFileSync(release, "release");
      await until(() => dead(pid), "unregistered shell refuses original work after owner crash");
      assert.equal(fs.existsSync(path.join(root, "original-work-started")), false);
      assert.equal(fs.existsSync(path.join(runDir(id), "result.json")), false);
    } finally {
      if (!dead(pid)) {
        process.kill(-pid, "SIGKILL");
      }
    }
    const continued = await call(
      "agent_runs",
      { action: "continue", id, prompt: "AFTER_NATIVE_ACTOR_CRASH", async: false },
      "continue-crashed-actor",
    );
    assert.equal(continued.isError, false, JSON.stringify(continued));
    assert.equal(continued.details.status, "completed");
    assert.notEqual(continued.details.id, id);
    const interrupted = await call(
      "agent_runs",
      { action: "inspect", id },
      "inspect-superseded-interrupted-run",
    );
    assert.equal(interrupted.details.process.live, true, "replacement remains messageable");
    assert.equal(
      interrupted.details.status,
      "interrupted",
      "replacement actor liveness must not resurrect an unfinished predecessor",
    );
    assert.equal(interrupted.details.completed, false, "no predecessor result was fabricated");
    const inventory = await call("agent_runs", { action: "list" }, "list-after-actor-crash");
    assert.equal(inventory.details.runs.find((run) => run.id === id).status, "interrupted");
    assert.equal(fs.existsSync(path.join(runDir(id), "result.json")), false);
  } else if (phase === "bash-seed") {
    fs.writeFileSync(
      path.join(root, "ticker.mjs"),
      `import fs from 'node:fs'; import {spawn} from 'node:child_process';\nconst root=${JSON.stringify(root)}; if(!process.argv.includes('--descendant')) { const child=spawn(process.execPath,[process.argv[1],'--descendant'],{stdio:'ignore'}); fs.writeFileSync(root+'/shell-family.json',JSON.stringify({pid:process.pid,descendant:child.pid})); }\nfs.writeFileSync(root+'/heartbeat-'+process.pid,'ready'); setInterval(()=>fs.appendFileSync(root+'/heartbeat-'+process.pid,'tick\\n'),20);`,
    );
    const receipt = await call(
      "delegate",
      { prompt: "BASH_HOLD_LITERAL", model: "single-agent-fixture/literal-model" },
      "bash-launch",
    );
    assert.equal(receipt.isError, false);
    runId = receipt.details.id;
    await until(
      () => fs.existsSync(path.join(root, "shell-family.json")),
      "native bash launches real owned shell family",
    );
    const family = readJSON(path.join(root, "shell-family.json"));
    await until(
      () =>
        [family.pid, family.descendant].every((pid) =>
          fs.existsSync(path.join(root, `heartbeat-${pid}`)),
        ),
      "both real shell descendants publish readiness",
    );
    fs.writeFileSync(
      seedFile,
      JSON.stringify({
        runId,
        sessionFile: manager.getSessionFile(),
        sessionId: manager.getSessionId(),
        pid: process.pid,
        childPid: requests()[0].pid,
        family,
      }),
    );
    process.kill(process.pid, "SIGKILL");
  } else if (phase === "cold-actor-stop") {
    const directory = runDir(runId);
    const identity = readJSON(path.join(directory, "actor.lock/process.json"));
    const ledger = path.join(directory, "shells", identity.token);
    const recordFile = path.join(ledger, fs.readdirSync(ledger)[0]);
    const shell = readJSON(recordFile);
    const prompt = "RECOVER_QUEUED_SHELL_CONTINUATION";
    const blocked = await call(
      "agent_runs",
      { action: "continue", id: runId, prompt },
      "continue-before-orphan-stop",
    );
    assert.equal(blocked.isError, true, JSON.stringify(blocked));
    assert.match(JSON.stringify(blocked.content), /Owned native shell work remains live/);
    const pending = readJSON(path.join(directory, "successor.json")).id;
    const pendingFiles = [
      path.join(runDir(pending), "launch.json"),
      path.join(directory, "commands", `${pending}.json`),
    ];
    const queued = pendingFiles.map((file) => fs.readFileSync(file));
    assert.equal(readJSON(pendingFiles[0]).prompt, prompt);
    assert.equal(fs.existsSync(path.join(directory, "admissions", `${pending}.json`)), false);
    const stillBlocked = await call(
      "agent_runs",
      { action: "continue", id: runId, prompt },
      "retry-while-orphan-shell-is-live",
    );
    assert.equal(stillBlocked.isError, true, JSON.stringify(stillBlocked));
    assert.match(JSON.stringify(stillBlocked.content), /Owned native shell work remains live/);
    const commands = () => fs.readdirSync(path.join(directory, "commands")).length;
    const beforeCommands = commands();
    const bystander = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(path.join(root, "bystander-heartbeat"))},'tick'),10);`,
      ],
      { detached: true, stdio: "ignore" },
    );
    try {
      await until(() => fs.existsSync(path.join(root, "bystander-heartbeat")), "bystander ready");
      const parentGroup = childProcess
        .execFileSync("ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8" })
        .trim();
      assert.match(parentGroup, /^[1-9]\d*$/);
      assert.notEqual(
        Number(parentGroup),
        process.pid,
        "live parent is not a detached group leader",
      );
      for (const [index, mutation] of [
        { ...shell, identity: "wrong process birth" },
        { ...shell, identity: "unverified" },
        { ...shell, token: "foreign actor generation" },
        { ...shell, pid: bystander.pid },
        { ...shell, pid: process.pid },
      ].entries()) {
        fs.writeFileSync(recordFile, JSON.stringify(mutation));
        // Every denial follows the actual controller processing the corrupted ledger.
        // oxlint-disable-next-line no-await-in-loop
        const denied = await call(
          "agent_runs",
          { action: "stop", id: runId },
          `bad-shell-${index}`,
        );
        assert.equal(denied.isError, true, JSON.stringify(denied));
        process.kill(seed.family.pid, 0);
        process.kill(seed.family.descendant, 0);
        process.kill(bystander.pid, 0);
        assert.equal(commands(), beforeCommands);
      }
      fs.writeFileSync(recordFile, JSON.stringify(shell));
      const stopped = await call("agent_runs", { action: "stop", id: runId }, "orphan-stop");
      assert.equal(stopped.isError, false, JSON.stringify(stopped));
      assert.equal(stopped.details.stopRequest, undefined, "dead actor cannot read a stop command");
      assert.equal(stopped.details.stopAcknowledged, false);
      assert.equal(stopped.details.completed, false);
      assert.equal(stopped.details.process.exitKnown, false);
      const dead = (pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      };
      await until(
        () => [shell.pid, seed.family.pid, seed.family.descendant].every(dead),
        "cold Stop kills actual orphan shell group",
      );
      assert.equal(commands(), beforeCommands);
      assert.equal(fs.existsSync(path.join(directory, "stop-acknowledged.json")), false);
      assert.equal(fs.existsSync(path.join(directory, "result.json")), false);
      const beat = path.join(root, "bystander-heartbeat"),
        size = fs.statSync(beat).size;
      await until(
        () => fs.statSync(beat).size > size,
        "unrelated process survives completed cold Stop",
      );
      const distinct = await call(
        "agent_runs",
        { action: "continue", id: runId, prompt: "DO_NOT_REPLACE_QUEUED_PROMPT" },
        "refuse-distinct-prompt-after-orphan-stop",
      );
      assert.equal(distinct.isError, true, JSON.stringify(distinct));
      assert.match(JSON.stringify(distinct.content), /awaiting native admission.*retry/i);
      const processFile = path.join(directory, "actor.lock/process.json");
      const retryWithout = async (file, expected) => {
        const held = `${file}.held`;
        fs.renameSync(file, held);
        try {
          // Remove actual published ownership/command evidence, never invent a receipt.
          const refused = await call(
            "agent_runs",
            { action: "continue", id: pending, prompt },
            `retry-without-${path.basename(file)}`,
          );
          assert.equal(refused.isError, true, JSON.stringify(refused));
          assert.match(JSON.stringify(refused.content), expected);
          assert.equal(fs.existsSync(path.join(directory, "admissions", `${pending}.json`)), false);
        } finally {
          fs.renameSync(held, file);
        }
      };
      for (const [file, expected] of [
        [pendingFiles[1], /awaiting native admission.*retry/i],
        [processFile, /Actor launch is ambiguous/],
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        await retryWithout(file, expected);
      }
      const recovered = await call(
        "agent_runs",
        { action: "continue", id: runId, prompt, async: false },
        "retry-queued-prompt-after-orphan-stop",
      );
      assert.equal(recovered.isError, false, JSON.stringify(recovered));
      assert.equal(recovered.details.id, pending, "retry resumes the same durable run");
      assert.equal(recovered.details.result.status, "completed");
      assert.equal(recovered.details.output.text, `CHILD_LITERAL_RESULT:${prompt}`);
      assert.equal(recovered.details.sessionFile, readJSON(pendingFiles[0]).sessionFile);
      assert.deepEqual(
        pendingFiles.map((file) => fs.readFileSync(file)),
        queued,
      );
      assert.equal(commands(), beforeCommands, "retry does not enqueue another execution");
      assert.equal(fs.existsSync(path.join(runDir(pending), "successor.json")), false);
      assert.equal(fs.existsSync(path.join(directory, "result.json")), false);
      assert.equal(
        readJSON(path.join(directory, "admissions", `${pending}.json`)).runId,
        pending,
        "the actual replacement actor admits the saved command",
      );
      assert.deepEqual(
        requests().map((request) => request.prompt),
        ["BASH_HOLD_LITERAL", prompt],
        "the first prompt is neither lost nor replayed and distinct retries never execute",
      );
      const journal = sdk.SessionManager.open(recovered.details.sessionFile);
      assert.equal(
        journal
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "user" &&
              JSON.stringify(entry.message.content).includes(prompt),
          ).length,
        1,
        "exactly one recovered prompt reaches the real native journal",
      );
    } finally {
      fs.writeFileSync(recordFile, JSON.stringify(shell));
      process.kill(-bystander.pid, "SIGKILL");
    }
  } else if (phase === "cold-stop") {
    const family = seed.family;
    const heartbeat = path.join(root, `heartbeat-${family.pid}`);
    const before = fs.statSync(heartbeat).size;
    await until(
      () => fs.statSync(heartbeat).size > before,
      "native shell keeps executing after actual main SIGKILL",
    );
    const processFile = path.join(runDir(runId), "actor.lock/process.json");
    const identity = readJSON(processFile);
    fs.writeFileSync(
      processFile,
      JSON.stringify({ ...identity, identity: "different process birth" }),
    );
    try {
      const denied = await call("agent_runs", { action: "stop", id: runId }, "mismatched-stop");
      assert.equal(denied.isError, true);
      process.kill(identity.pid, 0);
      process.kill(family.pid, 0);
      process.kill(family.descendant, 0);
      assert.equal(fs.existsSync(path.join(runDir(runId), "stop-acknowledged.json")), false);
    } finally {
      fs.writeFileSync(processFile, JSON.stringify(identity));
    }
    const ledger = path.join(runDir(runId), "shells", identity.token);
    const shell = readJSON(path.join(ledger, fs.readdirSync(ledger)[0]));
    const kill = process.kill;
    let stopping = false,
      raced = false;
    let stop;
    try {
      kill(identity.pid, "SIGSTOP");
      await until(
        () =>
          spawnSync("ps", ["-p", String(identity.pid), "-o", "state="], {
            encoding: "utf8",
          }).stdout.includes("T"),
        "actor is stopped before the controller sends SIGTERM",
      );
      process.kill = (pid, signal) => {
        const sent = kill(pid, signal);
        if (pid === -identity.pid && signal === "SIGTERM") {
          stopping = true;
        }
        if (stopping && pid === shell.pid && signal === 0 && !raced) {
          raced = true;
          // The real liveness syscall succeeded. Let native abort reap the shell
          // before the controller's following birth-identity lookup.
          kill(identity.pid, "SIGCONT");
          const gone = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `import {setTimeout as delay} from 'node:timers/promises';
             const deadline=Date.now()+10000;
             for (;;) {
               try { process.kill(${shell.pid},0); }
               catch(error) { if(error.code==='ESRCH') break; throw error; }
               if(Date.now()>deadline) throw new Error('native abort did not reap shell');
               await delay(10);
             }`,
            ],
            { encoding: "utf8", timeout: 15000 },
          );
          assert.equal(gone.status, 0, gone.stderr);
        }
        return sent;
      };
      stop = await call("agent_runs", { action: "stop", id: runId }, "cold-stop");
    } finally {
      process.kill = kill;
      try {
        kill(identity.pid, "SIGCONT");
      } catch (error) {
        assert.equal(error.code, "ESRCH");
      }
    }
    assert.equal(raced, true, "native shell exits between successful liveness and birth lookup");
    assert.equal(stop.isError, false, JSON.stringify(stop));
    assert.equal(stop.details.stopAcknowledged, false);
    assert.equal(stop.details.process.exitKnown, false);
    await until(
      () => fs.existsSync(path.join(runDir(runId), "stop-acknowledged.json")),
      "native actor actually handles stop",
    );
    const dead = (pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    };
    await until(
      () => [identity.pid, family.pid, family.descendant].every(dead),
      "actor and actual native shell/descendant exit",
    );
    assert.equal(readJSON(path.join(runDir(runId), "result.json")).status, "stopped");
    const inspected = await call("agent_runs", { action: "inspect", id: runId }, "stopped-inspect");
    assert.equal(inspected.details.process.live, false);
    assert.equal(
      inspected.details.process.exitKnown,
      false,
      "a cold liveness proof cannot invent the unavailable process exit code",
    );
  } else if (phase === "foreign" || phase === "fork-owner") {
    assert.notEqual(manager.getSessionId(), seed.sessionId);
    const listed = await call("agent_runs", { action: "list" }, "foreign-list");
    assert.deepEqual(listed.details.runs, []);
    const denied = await call(
      "agent_runs",
      { action: "inspect", id: seed.runId },
      "foreign-inspect",
    );
    assert.equal(denied.isError, true);
    assert.equal(notices().length, phase === "fork-owner" ? 1 : 0);
  } else if (phase === "cold-continue") {
    const receipt = await call(
      "agent_runs",
      { action: "continue", id: seed.runId, prompt: "COLD_FROZEN_LITERAL", async: false },
      "cold-continue",
    );
    assert.equal(receipt.isError, false, JSON.stringify(receipt));
    const saved = readJSON(path.join(runDir(seed.runId), "launch.json"));
    assert.equal(receipt.details.sessionFile, saved.sessionFile);
    assert.equal(receipt.details.thinking, "high");
    assert.equal(receipt.details.model, "single-agent-fixture/literal-model");
    const observed = requests().find((request) => request.prompt === "COLD_FROZEN_LITERAL");
    assert.notEqual(observed.pid, seed.childPid);
    assert.match(JSON.stringify(observed.context), /CHILD_LITERAL_RESULT:HOLD:first/);
    const startsBefore = new Set(requests().map((request) => request.pid)).size;
    fs.renameSync(saved.sessionFile, saved.sessionFile + ".held");
    try {
      const denied = await call(
        "agent_runs",
        { action: "continue", id: receipt.details.id, prompt: "MUST_NOT_START_LITERAL" },
        "missing-session",
      );
      assert.equal(denied.isError, true);
      assert.equal(new Set(requests().map((request) => request.pid)).size, startsBefore);
    } finally {
      fs.renameSync(saved.sessionFile + ".held", saved.sessionFile);
    }
    const savedLaunch = path.join(runDir(receipt.details.id), "launch.json");
    fs.renameSync(savedLaunch, savedLaunch + ".held");
    try {
      const denied = await call(
        "agent_runs",
        { action: "continue", id: receipt.details.id, prompt: "MUST_NOT_START_LITERAL" },
        "missing-launch",
      );
      assert.equal(denied.isError, true);
      assert.equal(new Set(requests().map((request) => request.pid)).size, startsBefore);
    } finally {
      fs.renameSync(savedLaunch + ".held", savedLaunch);
    }
  } else if (
    ["queue-drop", "queue-drop-two", "queue-retain", "queue-retain-one", "queue-steer"].includes(
      phase,
    )
  ) {
    const receipt = await call(
      "delegate",
      { prompt: "HOLD:queue", model: "single-agent-fixture/literal-model" },
      "queued-launch",
    );
    assert.equal(receipt.isError, false);
    runId = receipt.details.id;
    const queuedRuns = [{ id: runId, prompt: "HOLD:queue", release: "queue" }];
    await until(
      () => requests().some((request) => request.prompt === "HOLD:queue"),
      "native child provider starts",
    );
    if (phase !== "queue-drop") {
      const second = await call(
        "delegate",
        {
          prompt: "HOLD:queuesecond",
          model: "single-agent-fixture/literal-model",
        },
        "queued-second-launch",
      );
      assert.equal(second.isError, false, JSON.stringify(second));
      queuedRuns.push({
        id: second.details.id,
        prompt: "HOLD:queuesecond",
        release: "queuesecond",
      });
      await until(
        () => requests().some((request) => request.prompt === "HOLD:queuesecond"),
        "second independent child provider starts",
      );
    }
    const expectedIds = queuedRuns.map((run) => run.id).sort();
    const queuedIds = () => {
      const steering = session.agent.steeringMode;
      const followUp = session.agent.followUpMode;
      try {
        session.agent.steeringMode = "all";
        session.agent.followUpMode = "all";
        return session.agent
          .peekQueuedMessages()
          .filter(
            (message) => message.role === "custom" && message.customType === "agent-completion",
          )
          .map((message) => message.details.id)
          .sort();
      } finally {
        session.agent.steeringMode = steering;
        session.agent.followUpMode = followUp;
      }
    };
    const scanCall = (id) =>
      fauxAssistantMessage(
        [{ type: "toolCall", id, name: "agent_runs", arguments: { action: "inspect", id: runId } }],
        { stopReason: "toolUse" },
      );
    const entered = Promise.withResolvers();
    let cachePrefix;
    const deliverySteps = [];
    faux.setResponses([
      async (context, options) => {
        cachePrefix = structuredClone(context.messages);
        entered.resolve();
        while (!options?.signal?.aborted) {
          if (fs.existsSync(path.join(root, "release-parent"))) {
            return phase === "queue-steer"
              ? scanCall("steer-boundary-one")
              : fauxAssistantMessage("PARENT_HELD_COMPLETE");
          }
          // The explicit provider release or abort settles the actual native run.
          // oxlint-disable-next-line no-await-in-loop
          await delay(10);
        }
        return fauxAssistantMessage("PARENT_ABORTED", { stopReason: "aborted" });
      },
      async (context) => {
        if (phase === "queue-steer") {
          deliverySteps.push({
            receipts: notices().length,
            prefix: structuredClone(context.messages.slice(0, cachePrefix.length)),
          });
          return scanCall("steer-boundary-two");
        }
        return fauxAssistantMessage("NOTIFICATION_CONSUMED");
      },
      async (context) => {
        if (phase === "queue-steer") {
          deliverySteps.push({
            receipts: notices().length,
            prefix: structuredClone(context.messages.slice(0, cachePrefix.length)),
          });
          return scanCall("steer-boundary-three");
        }
        return fauxAssistantMessage("BARRIER_COMPLETE");
      },
      fauxAssistantMessage("PARENT_FINAL_AFTER_STEERING"),
    ]);
    const callsBeforeHeld = faux.state.callCount;
    const heldParent = session.prompt("HOLD_PARENT_LITERAL");
    await entered.promise;
    queuedRuns.forEach((run) => {
      fs.writeFileSync(path.join(root, `release-${run.release}`), "release");
    });
    const observe = () =>
      session.agent.state.tools
        .find((tool) => tool.name === "agent_runs")
        .execute("queue-barrier", { action: "inspect", id: runId }, new AbortController().signal);
    await until(
      () => queuedRuns.every((run) => fs.existsSync(path.join(runDir(run.id), "result.json"))),
      "both independent children publish their canonical result",
    );
    let inspected = await observe();
    assert.deepEqual(
      queuedIds(),
      expectedIds,
      "actual queued messages retain each distinct completion ID",
    );
    assert.equal(notices().length, 0);
    assert.equal(
      inspected.details.nativeReceipt,
      null,
      "queue admission is not native publication",
    );
    if (phase === "queue-steer") {
      fs.writeFileSync(path.join(root, "release-parent"), "release");
      await heldParent;
      assert.deepEqual(
        deliverySteps.map((step) => step.receipts),
        [1, 2],
        "one-at-a-time completions steer during the active tool loop, not after it",
      );
      for (const step of deliverySteps) {
        assert.deepEqual(
          step.prefix,
          cachePrefix,
          "completions append without rewriting the provider prompt prefix",
        );
      }
    } else if (phase.startsWith("queue-drop")) {
      session.clearQueue();
      assert.equal(session.agent.hasQueuedMessages(), false);
      if (phase === "queue-drop-two") {
        // Publish before the completion owner's settled scan, never into the busy queue.
        publishLegacyAtSettlement = () => {
          publishLegacyAtSettlement = undefined;
          assert.equal(session.isIdle, true);
          const legacy = path.join(
            root,
            "pi-subagents-runtime/async-subagent-results/settled-legacy.json",
          );
          fs.mkdirSync(path.dirname(legacy), { recursive: true });
          fs.writeFileSync(
            legacy,
            JSON.stringify({
              runId: "settled-legacy",
              sessionId: manager.getSessionId(),
              mode: "single",
              timestamp: 1,
              output: "LEGACY_SETTLED_RESULT",
            }),
          );
        };
      } else {
        const legacy = path.join(
          root,
          "pi-subagents-runtime/async-subagent-results/corrupt-legacy.json",
        );
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, '{"incomplete":');
      }
      inspected = await observe();
      assert.equal(inspected.details.nativeReceipt, null);
      assert.equal(
        session.agent.hasQueuedMessages(),
        false,
        "owner processed a scan while parent held: dropped admission stays absorbed until settlement",
      );
      fs.writeFileSync(path.join(root, "release-parent"), "release");
      await heldParent;
      if (phase === "queue-drop-two") {
        assert.equal(
          faux.state.callCount,
          callsBeforeHeld + 2,
          "mixed legacy/native idle backlog starts exactly one recovery request",
        );
        assert.equal(notices().length, 2, "settled backlog never requeues another deferred wakeup");
        assert.equal(
          manager
            .getEntries()
            .filter(
              (entry) => entry.type === "custom_message" && entry.customType === "subagent-notify",
            ).length,
          1,
        );
      }
    } else {
      const otherFaux = fauxProvider({
        provider: "independent-owner",
        models: [{ id: "other-model" }],
      });
      otherFaux.setResponses([fauxAssistantMessage("OTHER_NATIVE_OWNER_SETTLED")]);
      const otherModels = await sdk.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      otherModels.registerNativeProvider(otherFaux.provider);
      const otherManager = sdk.SessionManager.create(cwd, path.join(root, "other-owner-sessions"));
      assert.notEqual(otherManager.getSessionId(), manager.getSessionId());
      const otherServices = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime: otherModels,
        settingsManager: sdk.SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noThemes: true,
          noPromptTemplates: true,
          extensionFactories: [agents],
        },
      });
      const other = await sdk.createAgentSessionRuntime(
        async ({ sessionManager }) => ({
          ...(await sdk.createAgentSessionFromServices({
            services: otherServices,
            sessionManager,
            model: otherFaux.getModel(),
          })),
          services: otherServices,
          diagnostics: otherServices.diagnostics,
        }),
        { cwd, agentDir, sessionManager: otherManager },
      );
      try {
        await other.session.bindExtensions({
          mode: "print",
          onError: (error) => errors.push(error),
        });
        await other.session.prompt(
          "Settle a different actual native owner while the first owner remains held",
        );
        await other.session.waitForIdle();
        const terminal = otherManager
          .getBranch()
          .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
        assert.equal(terminal.message.content[0].text, "OTHER_NATIVE_OWNER_SETTLED");
        await observe();
        assert.deepEqual(
          queuedIds(),
          expectedIds,
          "another native owner's settlement cannot clear either admission",
        );
      } finally {
        await other.dispose();
      }
      await session.abort();
      await heldParent;
      assert.deepEqual(
        queuedIds(),
        expectedIds,
        "actual abort retains both distinct native queued messages",
      );
      await session.reload();
      await observe();
      assert.equal(notices().length, 0);
      assert.deepEqual(
        queuedIds(),
        expectedIds,
        "reload and the actual owner scan retain both admissions once",
      );
      await session.prompt("CONSUME_RETAINED_QUEUE_LITERAL");
    }
    await until(
      () => notices().length === expectedIds.length,
      "every independent completion publishes after native settlement/recovery",
    );
    await session.waitForIdle();
    await observe();
    assert.deepEqual(
      notices()
        .map((entry) => entry.details.id)
        .sort(),
      expectedIds,
    );
    queuedRuns.forEach((run) => {
      assert.match(
        notices().find((entry) => entry.details.id === run.id).content,
        new RegExp(`CHILD_LITERAL_RESULT:${run.prompt}`),
      );
    });
    const physical = fs
      .readFileSync(manager.getSessionFile(), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter(
        (entry) => entry.type === "custom_message" && entry.customType === "agent-completion",
      );
    assert.deepEqual(
      physical.map((entry) => entry.details.id).sort(),
      expectedIds,
      "each independent completion is physically published once without duplicates",
    );
  } else if (["legacy-queue", "legacy-reopen", "legacy-again", "legacy-mutation"].includes(phase)) {
    const hint = path.join(root, "pi-subagents-runtime/async-subagent-results", "legacy-7391.json");
    const result = seed?.legacyResult ?? {
      id: "legacy-7391",
      sessionId: manager.getSessionId(),
      mode: "single",
      state: "complete",
      success: true,
      timestamp: 123456789,
      summary: "LEGACY_COLD_RESULT",
      results: [
        { agent: "legacy-worker", success: true, output: "LEGACY_COLD_RESULT_FULL_OUTPUT_7391" },
      ],
    };
    const legacyNotices = () =>
      manager
        .getEntries()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === "subagent-notify",
        );
    if (phase === "legacy-mutation") {
      const file = manager.getSessionFile();
      const stat = fs.statSync(file);
      const before = fs.readFileSync(file, "utf8");
      const entries = before.trimEnd().split("\n").map(JSON.parse);
      const notice = entries.find(
        (entry) => entry.type === "custom_message" && entry.customType === "subagent-notify",
      );
      notice.details.completion.ownerSessionId = "0".repeat(manager.getSessionId().length);
      const changed = entries.map(JSON.stringify).join("\n") + "\n";
      assert.equal(Buffer.byteLength(changed), Buffer.byteLength(before));
      fs.writeFileSync(file, changed);
      fs.utimesSync(file, stat.atime, stat.mtime);
    }
    if (phase === "legacy-again" || phase === "legacy-mutation") {
      fs.mkdirSync(path.dirname(hint), { recursive: true });
      fs.writeFileSync(hint, JSON.stringify(result));
    }
    if (phase === "legacy-queue") {
      const entered = Promise.withResolvers();
      faux.setResponses([
        async (_context, options) => {
          entered.resolve();
          await new Promise((resolve) =>
            options.signal.addEventListener("abort", resolve, { once: true }),
          );
          return fauxAssistantMessage("PARENT_ABORTED");
        },
      ]);
      void session.prompt("Hold native parent before legacy queue consumption");
      await entered.promise;
      fs.mkdirSync(path.dirname(hint), { recursive: true });
      fs.writeFileSync(hint, JSON.stringify(result));
      await until(
        () => session.agent.hasQueuedMessages(),
        "sole legacy input enters real native custom queue",
      );
      assert.equal(fs.existsSync(hint), true);
      assert.equal(legacyNotices().length, 0);
      assert.equal(
        fs
          .readdirSync(path.dirname(runDir("legacy-7391")), { withFileTypes: true })
          .filter((entry) => entry.isDirectory()).length,
        0,
        "no canonical owned-run was invented",
      );
      fs.writeFileSync(
        seedFile,
        JSON.stringify({
          runId: "legacy-7391",
          sessionId: manager.getSessionId(),
          sessionFile: manager.getSessionFile(),
          legacyResult: result,
        }),
      );
      fs.writeFileSync(
        path.join(root, "legacy-queue-proof.json"),
        JSON.stringify({
          hintExists: true,
          notices: 0,
          calls: faux.state.callCount,
          owners: manager
            .getEntries()
            .filter((entry) => entry.type === "custom" && entry.customType === "subagent-run")
            .length,
        }),
      );
      process.kill(process.pid, "SIGKILL");
    }
    await until(
      () => !fs.existsSync(hint),
      "only an actual LF-published native notice retires the sole legacy hint",
    );
    await session.waitForIdle();
    assert.equal(legacyNotices().length, phase === "legacy-mutation" ? 2 : 1);
    assert.equal(legacyNotices().at(-1).content, JSON.stringify(result));
    assert.equal(faux.state.callCount, phase === "legacy-again" ? 0 : 1);
    assert.equal(
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "subagent-run").length,
      0,
    );
    assert.equal(
      fs
        .readdirSync(path.dirname(runDir("legacy-7391")), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length,
      0,
    );
    fs.writeFileSync(
      path.join(root, `${phase}-proof.json`),
      JSON.stringify({
        hintExists: fs.existsSync(hint),
        notices: legacyNotices().length,
        calls: faux.state.callCount,
        owners: 0,
      }),
    );
  } else if (phase.startsWith("cwd-invalid-")) {
    const target = path.join(root, "different-child-cwd");
    fs.mkdirSync(target);
    const result = await call(
      "delegate",
      {
        prompt: "CWD_MUST_NOT_DISPATCH",
        cwd: target,
        model: "single-agent-fixture/literal-model",
        async: false,
      },
      "invalid-cwd-owner",
    );
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(requests().length, 0, "incompatible cwd owner fails before provider dispatch");
    assert.match(JSON.stringify(result), /directory|cwd|CWD_OWNER_CONTROLLED_ERROR/i);
    if (phase === "cwd-invalid-missing-setter") {
      const id = result.details.id;
      const names = ["launch.json", "result.json", "output.txt"];
      const frozen = names.map((name) => fs.readFileSync(path.join(runDir(id), name)));
      const oldActor = readJSON(path.join(runDir(id), "actor.lock/process.json")).pid;
      await until(() => {
        try {
          process.kill(oldActor, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      }, "failed startup actor actually exits before repair");
      const file = path.join(agentDir, "settings.json"),
        configured = readJSON(file);
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...configured,
          extensions: configured.extensions.filter((entry) => entry !== cwdOwner),
        }),
      );
      const continued = await call(
        "agent_runs",
        {
          action: "continue",
          id,
          prompt: "REPAIRED_CWD_LITERAL",
          async: false,
        },
        "repaired-startup-continuation",
      );
      assert.equal(continued.isError, false, JSON.stringify(continued));
      assert.deepEqual(
        requests().map((request) => request.prompt),
        ["REPAIRED_CWD_LITERAL"],
      );
      assert.equal(continued.details.output.text, "CHILD_LITERAL_RESULT:REPAIRED_CWD_LITERAL");
      names.forEach((name, index) =>
        assert.deepEqual(fs.readFileSync(path.join(runDir(id), name)), frozen[index]),
      );
      const rename = fs.renameSync;
      let faults = 0;
      fs.renameSync = (source, destination) => {
        if (destination.endsWith("/actor.lock/process.json") && faults === 0) {
          faults++;
          throw Object.assign(new Error("CONTROLLED_POST_SPAWN_PUBLICATION_EIO"), { code: "EIO" });
        }
        return rename(source, destination);
      };
      syncBuiltinESMExports();
      try {
        const failedPublication = await call(
          "delegate",
          {
            prompt: "HOLD:publication",
            model: "single-agent-fixture/literal-model",
            async: false,
          },
          "post-spawn-publication-fault",
        );
        assert.equal(failedPublication.isError, true);
        assert.match(
          JSON.stringify(failedPublication.content),
          /CONTROLLED_POST_SPAWN_PUBLICATION_EIO/,
        );
        assert.equal(faults, 1, "the actual main process failed after spawning, not before launch");
      } finally {
        fs.renameSync = rename;
        syncBuiltinESMExports();
      }
      await until(
        () => requests().some((r) => r.prompt === "HOLD:publication"),
        "original child actually starts despite foreground publication error",
      );
      const listed = await call("agent_runs", { action: "list" }, "discover-ambiguous-launch");
      const orphan = listed.details.runs.find(
        (run) => run.id !== id && run.id !== continued.details.id,
      );
      assert.ok(orphan, "canonical launch remains discoverable after post-spawn write failure");
      assert.equal(orphan.completed, false);
      const claim = readJSON(path.join(runDir(orphan.id), "actor.lock/claim.json"));
      const ready = readJSON(path.join(runDir(orphan.id), "ready.json"));
      assert.equal(
        ready.token,
        claim.token,
        "the originally claimed actor publishes its own identity",
      );
      fs.writeFileSync(path.join(root, "release-publication"), "release");
      const original = await call(
        "agent_runs",
        { action: "wait", id: orphan.id },
        "publication-original-result",
      );
      assert.equal(original.details.output.text, "CHILD_LITERAL_RESULT:HOLD:publication");
      const originalBytes = names.map((name) =>
        fs.readFileSync(path.join(runDir(orphan.id), name)),
      );
      const retry = await call(
        "agent_runs",
        {
          action: "continue",
          id: orphan.id,
          prompt: "PUBLICATION_RETRY_LITERAL",
          async: false,
        },
        "publication-continue",
      );
      assert.equal(retry.isError, false, JSON.stringify(retry));
      assert.equal(retry.details.sessionFile, original.details.sessionFile);
      assert.match(retry.details.output.text, /PUBLICATION_RETRY_LITERAL/);
      assert.equal(requests().filter((r) => r.prompt === "HOLD:publication").length, 1);
      assert.equal(requests().filter((r) => r.prompt === "PUBLICATION_RETRY_LITERAL").length, 1);
      assert.equal(requests().find((r) => r.prompt === "PUBLICATION_RETRY_LITERAL").pid, ready.pid);
      names.forEach((name, index) =>
        assert.deepEqual(fs.readFileSync(path.join(runDir(orphan.id), name)), originalBytes[index]),
      );
    }
  } else if (phase === "cwd" || phase === "cwd-reopen") {
    const active = path.join(root, "active"),
      child = path.join(active, "child");
    const changed = path.join(root, "changed");
    for (const [directory, literal] of [
      [cwd, "PARENT_A"],
      [active, "ACTIVE_B"],
      [child, "CHILD_C"],
      [changed, "CHANGED_D"],
    ]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "marker.txt"), literal);
    }
    if (phase === "cwd") {
      await call("change_dir", { path: active }, "select-parent-active-b");
      assert.equal(manager.getCwd(), cwd);
      const before = fs.readFileSync(manager.getSessionFile());
      const first = await call(
        "delegate",
        {
          prompt: "CWD_READ_FIRST",
          cwd: "child",
          context: "fork",
          model: "single-agent-fixture/literal-model",
          async: false,
        },
        "fork-child-c",
      );
      assert.equal(first.isError, false, JSON.stringify(first));
      assert.equal(fs.realpathSync(first.details.cwd), fs.realpathSync(child));
      assert.match(first.details.output.text, /CHILD_C/);
      assert.doesNotMatch(first.details.output.text, /ACTIVE_B|PARENT_A/);
      assert.deepEqual(
        fs.readFileSync(manager.getSessionFile()).subarray(0, before.length),
        before,
      );
      const moved = await call(
        "agent_runs",
        {
          action: "continue",
          id: first.details.id,
          prompt: "CWD_CHANGE_AND_READ",
          async: false,
        },
        "child-change-d",
      );
      assert.equal(moved.isError, false, JSON.stringify(moved));
      assert.match(moved.details.output.text, /CHANGED_D/);
      assert.match(moved.details.output.text, new RegExp(changed));
      runId = moved.details.id;
      const inherited = readJSON(path.join(runDir(first.details.id), "launch.json"));
      const header = fs.readFileSync(inherited.sessionFile, "utf8").split("\n")[0];
      assert.equal(fs.realpathSync(JSON.parse(header).cwd), fs.realpathSync(child));
      fs.writeFileSync(
        seedFile,
        JSON.stringify({
          runId,
          sessionId: manager.getSessionId(),
          sessionFile: manager.getSessionFile(),
          childPid: requests()[0].pid,
          nativeHeader: header,
        }),
      );
    } else {
      const continued = await call(
        "agent_runs",
        {
          action: "continue",
          id: runId,
          prompt: "CWD_READ_AFTER_REOPEN",
          async: false,
        },
        "reopen-child-d",
      );
      assert.equal(continued.isError, false, JSON.stringify(continued));
      assert.match(continued.details.output.text, /CHANGED_D/);
      assert.match(continued.details.output.text, new RegExp(changed));
      assert.equal(
        fs.realpathSync(continued.details.cwd),
        fs.realpathSync(child),
        "launch snapshot remains C while owner restores D",
      );
      assert.equal(
        fs.readFileSync(continued.details.sessionFile, "utf8").split("\n")[0],
        seed.nativeHeader,
      );
      assert.notEqual(requests().at(-1).pid, seed.childPid);
    }
    const selection = { sessionManager: manager };
    agentAPI.events.emit("pi-change-working-dir:resolve-execution-cwd", selection);
    assert.equal(
      fs.realpathSync(selection.result.cwd),
      fs.realpathSync(active),
      "child cannot mutate parent directory selection",
    );
  } else if (phase === "custom-bash") {
    const extension = path.join(root, "custom-remote-shell.mjs");
    fs.writeFileSync(
      extension,
      `
      import fs from 'node:fs';
      export default function(pi) {
        pi.registerTool({
          name:'bash',label:'Remote shell',description:'Extension-owned shell',
          parameters:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false},
          execute:async (_id,input)=>{
            fs.writeFileSync(${JSON.stringify(path.join(root, "custom-command.json"))},JSON.stringify(input));
            return {content:[{type:'text',text:'CUSTOM_REMOTE_OWNER_OUTPUT'}],details:{}};
          }
        });
      }
    `,
    );
    const file = path.join(agentDir, "settings.json"),
      configured = readJSON(file);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...configured, extensions: [...configured.extensions, extension] }),
    );
    const outcome = await call(
      "delegate",
      {
        prompt: "CUSTOM_BASH_LITERAL",
        model: "single-agent-fixture/literal-model",
        async: false,
      },
      "custom-bash-owner",
    );
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    assert.match(outcome.details.output.text, /CUSTOM_REMOTE_OWNER_OUTPUT/);
    assert.deepEqual(readJSON(path.join(root, "custom-command.json")), {
      command: "CUSTOM_UNTOUCHED_COMMAND",
    });
    assert.equal(fs.existsSync(path.join(runDir(outcome.details.id), "shells")), false);
  } else if (phase === "trust") {
    const globalFile = path.join(agentDir, "settings.json");
    const globalSettings = readJSON(globalFile);
    fs.writeFileSync(globalFile, JSON.stringify({ ...globalSettings, defaultProjectTrust: "ask" }));
    for (const decision of ["untrusted", "remembered", "global-policy"]) {
      const target = path.join(root, decision);
      const marker = path.join(root, `extension-${decision}`);
      fs.mkdirSync(path.join(target, ".pi/extensions"), { recursive: true });
      fs.writeFileSync(path.join(target, "AGENTS.md"), `TARGET_PROJECT_INSTRUCTION_${decision}`);
      fs.writeFileSync(
        path.join(target, ".pi/settings.json"),
        JSON.stringify({
          defaultProjectTrust: "always",
        }),
      );
      fs.writeFileSync(
        path.join(target, ".pi/extensions/sentinel.js"),
        `import fs from 'node:fs'; export default function(){fs.writeFileSync(${JSON.stringify(marker)},'loaded');}`,
      );
      if (decision === "remembered") {
        new sdk.ProjectTrustStore(agentDir).set(target, true);
      } else if (decision === "global-policy") {
        fs.writeFileSync(
          globalFile,
          JSON.stringify({ ...globalSettings, defaultProjectTrust: "always" }),
        );
      }
      // Every assertion follows the actual target loader and provider completing.
      // oxlint-disable-next-line no-await-in-loop
      const result = await call(
        "delegate",
        {
          prompt: `TRUST_LITERAL_${decision}`,
          cwd: target,
          model: "single-agent-fixture/literal-model",
          async: false,
        },
        `trust-${decision}`,
      );
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(
        readJSON(path.join(runDir(result.details.id), "launch.json")).trusted,
        decision !== "untrusted",
      );
      assert.equal(fs.existsSync(marker), decision !== "untrusted");
      const observed = requests().find((request) => request.prompt === `TRUST_LITERAL_${decision}`);
      assert.match(
        JSON.stringify(observed.context),
        new RegExp(`TARGET_PROJECT_INSTRUCTION_${decision}`),
      );
    }
  } else if (phase === "receipt-mutation") {
    const completed = await call(
      "delegate",
      {
        prompt: "RECEIPT_MUTATION_LITERAL",
        model: "single-agent-fixture/literal-model",
        async: false,
      },
      "mutation-owned-wait",
    );
    assert.equal(completed.isError, false, JSON.stringify(completed));
    runId = completed.details.id;
    assert.equal(notices().length, 0, "actual finalized native wait is the receipt");
    const file = manager.getSessionFile();
    const stat = fs.statSync(file);
    const before = fs.readFileSync(file, "utf8");
    const lines = before.trimEnd().split("\n").map(JSON.parse);
    const physicalWait = lines.find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === "mutation-owned-wait",
    );
    assert.equal(physicalWait.message.details.receivedResult, true);
    physicalWait.message.details.owner = "0".repeat(manager.getSessionId().length);
    const changed = lines.map(JSON.stringify).join("\n") + "\n";
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(before));
    fs.writeFileSync(file, changed);
    fs.utimesSync(file, stat.atime, stat.mtime);
    faux.setResponses([fauxAssistantMessage("MUTATED_RECEIPT_FALLBACK_CONSUMED")]);
    const raw = session.agent.state.tools.find((tool) => tool.name === "agent_runs");
    const inspected = await raw.execute(
      "mutation-scan",
      { action: "inspect", id: runId },
      new AbortController().signal,
    );
    assert.equal(
      inspected.details.nativeReceipt,
      null,
      "same-size edited foreign physical receipt overrides stale manager entries",
    );
    await until(
      () => notices().length === 1,
      "processed scan publishes exactly one genuine fallback",
    );
    await session.waitForIdle();
    const reconciled = await raw.execute(
      "mutation-reconcile",
      { action: "inspect", id: runId },
      new AbortController().signal,
    );
    assert.equal(reconciled.details.nativeReceipt, notices()[0].id);
    assert.equal(
      requests().filter((request) => request.prompt === "RECEIPT_MUTATION_LITERAL").length,
      1,
    );
  } else if (phase === "accounting-lf") {
    const launched = await call(
      "delegate",
      {
        prompt: "DELAYED_LF_LITERAL",
        model: "single-agent-fixture/literal-model",
      },
      "delayed-lf-launch",
    );
    runId = launched.details.id;
    await until(
      () => fs.existsSync(path.join(runDir(runId), "result.json")),
      "native successful result with withheld terminal LF",
    );
    const pending = readJSON(path.join(runDir(runId), "result.json"));
    assert.equal(pending.status, "completed");
    assert.equal(pending.terminalEntryId, undefined);
    assert.equal(pending.contributions, undefined);
    assert.match(pending.accountingError, /LF-published/);
    const incomplete = await call(
      "agent_runs",
      { action: "wait", id: runId },
      "incomplete-native-usage",
    );
    assert.equal(incomplete.isError, false);
    assert.equal(incomplete.details.output.text, "CHILD_LITERAL_RESULT:DELAYED_LF_LITERAL");
    assert.equal(session.getSessionStats().cost, 0);
    const source = readJSON(path.join(root, "delayed-lf.json")).file;
    assert.notEqual(fs.readFileSync(source).at(-1), 10);
    const resultFile = path.join(runDir(runId), "result.json");
    const pendingBytes = fs.readFileSync(resultFile);
    const open = fs.openSync;
    let usageReads = 0;
    fs.openSync = (file, flags, ...args) => {
      if (file === source && flags === "r") {
        usageReads++;
      }
      return open(file, flags, ...args);
    };
    syncBuiltinESMExports();
    try {
      fs.appendFileSync(source, "\n");
      // Stay in this turn's microtasks: the periodic completion owner must not
      // repair billing between metadata observation and its byte/read assertions.
      const raw = session.agent.state.tools.find((tool) => tool.name === "agent_runs");
      const listed = await raw.execute(
        "pending-accounting-list",
        { action: "list" },
        new AbortController().signal,
      );
      assert.notEqual(listed.isError, true);
      const metadata = listed.details.runs.find((run) => run.id === runId);
      assert.equal(metadata.status, "completed");
      assert.equal("output" in metadata, false);
      assert.deepEqual(
        fs.readFileSync(resultFile),
        pendingBytes,
        "native metadata inventory cannot repair pending accounting",
      );
      assert.equal(usageReads, 0, "metadata-only reads never open the child usage journal");
      const inspected = await raw.execute(
        "pending-accounting-inspect",
        { action: "inspect", id: runId },
        new AbortController().signal,
      );
      assert.equal(inspected.details.result.accountingPending, undefined);
      assert.ok(usageReads > 0, "explicit native inspection still reads and repairs accounting");
      assert.notDeepEqual(fs.readFileSync(resultFile), pendingBytes);
      assert.equal(session.getSessionStats().cost, 0, "inspection is not finalized collection");
    } finally {
      fs.openSync = open;
      syncBuiltinESMExports();
    }
    const repaired = await call(
      "agent_runs",
      { action: "wait", id: runId },
      "repaired-native-usage",
    );
    assert.equal(repaired.isError, false);
    assert.equal(repaired.details.result.accountingError, undefined);
    assert.equal(repaired.details.result.accountingPending, undefined);
    assert.equal(
      repaired.details.result.terminalEntryId,
      pending.accountingPending.terminalCandidate,
    );
    assert.deepEqual(repaired.usage, {
      input: 3,
      output: 5,
      cacheRead: 13,
      cacheWrite: 1,
      totalTokens: 22,
      reasoning: 2,
      cacheWrite1h: 1,
      cost: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    });
    assert.equal(session.getSessionStats().cost, 0.25);
    assert.equal(requests().filter((request) => request.prompt === "DELAYED_LF_LITERAL").length, 1);
  } else if (phase === "saved-single" || phase === "saved-reopen") {
    const legacyId = seed?.legacyId ?? "legacy-saved-7391";
    if (phase === "saved-reopen") {
      const before = requests().length;
      const repeated = await call(
        "agent_runs",
        { action: "continue", id: legacyId, prompt: "MUST_NOT_REPLAY", async: false },
        "saved-cold-repeat",
      );
      assert.equal(repeated.isError, false, JSON.stringify(repeated));
      assert.equal(repeated.details.id, seed.runId);
      assert.equal(requests().length, before, "durable adoption cannot replay after native reopen");
    } else {
      const frozenCwd = path.join(root, "legacy-cwd");
      fs.mkdirSync(frozenCwd);
      const childManager = sdk.SessionManager.create(frozenCwd, path.join(root, "legacy-sessions"));
      const oldProvider = fauxProvider({
        provider: "single-agent-fixture",
        models: [{ id: "literal-model", reasoning: true }],
      });
      oldProvider.setResponses([fauxAssistantMessage("LEGACY_NATIVE_MEMORY_7391")]);
      models.registerNativeProvider(oldProvider.provider);
      const childLoader = new sdk.DefaultResourceLoader({
        cwd: frozenCwd,
        agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
      });
      await childLoader.reload();
      const { session: savedChild } = await sdk.createAgentSession({
        cwd: frozenCwd,
        agentDir,
        settingsManager: settings,
        modelRuntime: models,
        model: oldProvider.getModel(),
        resourceLoader: childLoader,
        sessionManager: childManager,
        thinkingLevel: "off",
      });
      await savedChild.prompt("Original native single-child prompt");
      await savedChild.waitForIdle();
      savedChild.dispose();
      const header = fs.readFileSync(childManager.getSessionFile(), "utf8").split("\n")[0];
      const contract = {
        recordVersion: 3,
        nativeSessionId: childManager.getSessionId(),
        sessionFile: childManager.getSessionFile(),
        effectiveConfiguration: { model: "single-agent-fixture/literal-model", thinking: "off" },
        launch: {
          model: "single-agent-parent/parent-model",
          thinking: "high",
          cwd: frozenCwd,
          context: "fork",
          projectTrusted: true,
          agent: { name: "retired-profile", systemPrompt: "MUST_NOT_REVIVE_PROFILE_BODY" },
        },
      };
      const owned = {
        runId: legacyId,
        ownerSessionId: manager.getSessionId(),
        source: "foreground",
        mode: "single",
        cwd: frozenCwd,
        task: "old native task",
        startedAt: 12345,
        rootRunId: legacyId,
        children: [{ agent: "retired-profile", index: 0, sessionFile: contract.sessionFile }],
      };
      // Publish the actual owner journal before asking the new reader to adopt its snapshot.
      await session.prompt("Publish native owner before appending its legacy run record");
      manager.appendCustomEntry("subagent-run", owned);
      const source = path.join(agentDir, "sessions/subagent-runs", legacyId);
      const ownerFile = path.join(source, "question-owner.json");
      const contractFile = path.join(source, "contracts/0.json");
      fs.mkdirSync(path.dirname(contractFile), { recursive: true });
      const save = () => {
        fs.writeFileSync(ownerFile, JSON.stringify({ sessionId: manager.getSessionId() }));
        fs.writeFileSync(contractFile, JSON.stringify(contract));
      };
      save();
      const rejected = async (label) => {
        const before = requests().length;
        const response = await call(
          "agent_runs",
          { action: "continue", id: legacyId, prompt: `MUST_NOT_START_${label}` },
          `saved-reject-${label}`,
        );
        assert.equal(response.isError, true, JSON.stringify(response));
        assert.equal(requests().length, before);
        assert.equal(
          fs
            .readdirSync(path.dirname(runDir(legacyId)))
            .filter((file) => file !== "attachment.json").length,
          0,
          "rejected legacy evidence must not create a run or adoption claim",
        );
      };
      fs.writeFileSync(ownerFile, JSON.stringify({ sessionId: "foreign-native-owner" }));
      await rejected("foreign-owner");
      save();
      manager.appendCustomEntry("subagent-run", {
        ...owned,
        ownerSessionId: "foreign-native-owner",
      });
      await rejected("foreign-native-record");
      manager.appendCustomEntry("subagent-run", { ...owned, mode: "chain" });
      await rejected("multistep");
      manager.appendCustomEntry("subagent-run", owned);
      fs.writeFileSync(contractFile, JSON.stringify({ ...contract, pid: process.pid }));
      await rejected("live-producer");
      fs.writeFileSync(contractFile, JSON.stringify({ ...contract, launch: undefined }));
      await rejected("missing-launch");
      fs.writeFileSync(
        contractFile,
        JSON.stringify({
          ...contract,
          effectiveConfiguration: { model: "claude-code/sonnet", thinking: "off" },
        }),
      );
      await rejected("non-native");
      save();
      fs.renameSync(contract.sessionFile, contract.sessionFile + ".held");
      await rejected("missing-session");
      fs.renameSync(contract.sessionFile + ".held", contract.sessionFile);
      const continued = await call(
        "agent_runs",
        {
          action: "continue",
          id: legacyId,
          prompt: "SAVED_NATIVE_CONTINUATION_7391",
          async: false,
        },
        "saved-native-continue",
      );
      assert.equal(continued.isError, false, JSON.stringify(continued));
      assert.equal(continued.details.sessionFile, contract.sessionFile);
      assert.equal(continued.details.sessionId, contract.nativeSessionId);
      assert.equal(continued.details.model, "single-agent-fixture/literal-model");
      assert.equal(continued.details.thinking, "off");
      assert.equal(continued.details.cwd, frozenCwd);
      assert.equal(continued.details.context, "fork");
      assert.equal(fs.readFileSync(contract.sessionFile, "utf8").split("\n")[0], header);
      const observed = requests().find(
        (request) => request.prompt === "SAVED_NATIVE_CONTINUATION_7391",
      );
      assert.equal(observed.cwd, fs.realpathSync(frozenCwd));
      assert.match(JSON.stringify(observed.context), /LEGACY_NATIVE_MEMORY_7391/);
      assert.doesNotMatch(JSON.stringify(observed.context), /MUST_NOT_REVIVE_PROFILE_BODY/);
      const before = requests().length;
      const duplicate = await call(
        "agent_runs",
        { action: "continue", id: legacyId, prompt: "MUST_NOT_REPLAY" },
        "saved-repeat",
      );
      assert.equal(duplicate.details.id, continued.details.id);
      assert.equal(duplicate.details.receipt, "existing-successor");
      assert.equal(requests().length, before);
      fs.writeFileSync(
        seedFile,
        JSON.stringify({
          legacyId,
          runId: continued.details.id,
          sessionFile: manager.getSessionFile(),
          sessionId: manager.getSessionId(),
        }),
      );
    }
  } else if (phase === "usage-reopen") {
    assert.equal(session.getSessionStats().cost, 0.5);
    const repeated = await call("agent_runs", { action: "wait", id: seed.runId }, "reopened-wait");
    assert.equal(repeated.usage, undefined);
    assert.equal(session.getSessionStats().cost, 0.5);
    const physical = sdk.SessionManager.open(manager.getSessionFile())
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.usage !== undefined,
      );
    assert.equal(physical.length, 2);
  } else if (phase === "usage") {
    const receipt = await call(
      "delegate",
      { prompt: "USAGE_LITERAL", model: "single-agent-fixture/literal-model" },
      "usage-launch",
    );
    runId = receipt.details.id;
    await until(
      () => fs.existsSync(path.join(runDir(runId), "result.json")),
      "native child usage result publishes",
    );
    await until(
      () => notices().length === 1,
      "background custom notice is physically published before accounting checks",
    );
    await session.waitForIdle();
    assert.equal(session.getSessionStats().cost, 0);
    const rawTool = session.agent.state.tools.find((tool) => tool.name === "agent_runs");
    const discarded = await rawTool.execute(
      "discarded-wait",
      { action: "wait", id: runId },
      new AbortController().signal,
    );
    assert.equal(discarded.usage, undefined, "result preparation only carries intent");
    assert.equal(session.getSessionStats().cost, 0, "discarded result never reserves a charge");
    const inspection = await call("agent_runs", { action: "inspect", id: runId }, "usage-inspect");
    assert.equal(inspection.usage, undefined);
    faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "concurrent-one",
            name: "agent_runs",
            arguments: { action: "wait", id: runId },
          },
          {
            type: "toolCall",
            id: "concurrent-two",
            name: "agent_runs",
            arguments: { action: "wait", id: runId },
          },
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("CONCURRENT_WAITS_FINISHED"),
    ]);
    await session.prompt("Collect the same child through concurrent native calls");
    const receipts = [
      resultEntries("concurrent-one")[0].message,
      resultEntries("concurrent-two")[0].message,
    ];
    const charged = receipts.filter((message) => message.usage !== undefined);
    assert.equal(charged.length, 1);
    assert.deepEqual(charged[0].usage, {
      input: 3,
      output: 5,
      cacheRead: 13,
      cacheWrite: 1,
      totalTokens: 22,
      reasoning: 2,
      cacheWrite1h: 1,
      cost: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    });
    assert.equal(session.getSessionStats().cost, 0.25);
    const next = await call(
      "agent_runs",
      { action: "continue", id: runId, prompt: "USAGE_CONTINUATION_LITERAL", async: false },
      "usage-continuation",
    );
    assert.deepEqual(next.usage, {
      input: 3,
      output: 5,
      cacheRead: 13,
      cacheWrite: 1,
      totalTokens: 22,
      reasoning: 2,
      cacheWrite1h: 1,
      cost: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    });
    assert.equal(
      session.getSessionStats().cost,
      0.5,
      "continuation charges only newly published direct-child native entries",
    );
    fs.writeFileSync(
      seedFile,
      JSON.stringify({
        runId: next.details.id,
        sessionFile: manager.getSessionFile(),
        sessionId: manager.getSessionId(),
        childPid: requests()[0].pid,
        pid: process.pid,
      }),
    );
  } else if (phase === "cancellation") {
    const launched = await call(
      "delegate",
      { prompt: "HOLD:existing", model: "single-agent-fixture/literal-model" },
      "existing-launch",
    );
    const id = launched.details.id;
    await until(
      () => requests().some((request) => request.prompt === "HOLD:existing"),
      "existing native producer is really running",
    );
    const cancel = new AbortController();
    const wait = session.agent.state.tools
      .find((tool) => tool.name === "agent_runs")
      .execute("existing-wait", { action: "wait", id }, cancel.signal);
    cancel.abort();
    const cancelled = await wait;
    assert.equal(cancelled.details.wait, "cancelled");
    const barrier = await call("agent_runs", { action: "inspect", id }, "existing-still-live");
    assert.equal(barrier.details.process.live, true);
    assert.equal(fs.existsSync(path.join(runDir(id), "stop-acknowledged.json")), false);
    fs.writeFileSync(path.join(root, "release-existing"), "release");
    const completed = await call(
      "agent_runs",
      { action: "wait", id, async: false },
      "existing-complete",
    );
    assert.equal(completed.details.output.text, "CHILD_LITERAL_RESULT:HOLD:existing");
    faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "continuation-foreground",
            name: "agent_runs",
            arguments: { action: "continue", id, prompt: "HOLD:foreground", async: false },
          },
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("CONTINUATION_ABORT_FOLLOWUP"),
    ]);
    const continued = session.prompt("Launch new cancellation-owned foreground continuation");
    await until(
      () => requests().some((r) => r.prompt === "HOLD:foreground"),
      "new continuation really starts",
    );
    await session.abort();
    await continued;
    const successor = readJSON(path.join(runDir(id), "successor.json")).id;
    await until(
      () => fs.existsSync(path.join(runDir(successor), "result.json")),
      "owned foreground continuation publishes aborted native result",
    );
    assert.equal(readJSON(path.join(runDir(successor), "result.json")).status, "stopped");
    assert.equal(fs.existsSync(path.join(runDir(id), "stop-acknowledged.json")), true);
    assert.equal(readJSON(path.join(runDir(id), "result.json")).status, "completed");
    const nativeCallId = "owned-foreground";
    faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: nativeCallId,
            name: "delegate",
            arguments: {
              prompt: "HOLD:owned",
              model: "single-agent-fixture/literal-model",
              async: false,
            },
          },
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ABORT_FOLLOWUP"),
    ]);
    const foreground = session.prompt("Launch cancellation-owned foreground work");
    await until(
      () => requests().some((request) => request.prompt === "HOLD:owned"),
      "new owned native foreground producer is really running",
    );
    await session.abort();
    await foreground;
    const ownerDir = path.dirname(runDir(id));
    const owned = fs
      .readdirSync(ownerDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        id: entry.name,
        launch: readJSON(path.join(ownerDir, entry.name, "launch.json")),
      }))
      .find((entry) => entry.launch.prompt === "HOLD:owned");
    await until(
      () => fs.existsSync(path.join(runDir(owned.id), "stop-acknowledged.json")),
      "actual actor acknowledges cancellation of newly created owned work",
    );
    await until(
      () => fs.existsSync(path.join(runDir(owned.id), "result.json")),
      "cancelled producer publishes its actual native outcome",
    );
    assert.equal(readJSON(path.join(runDir(owned.id), "result.json")).status, "stopped");
    assert.equal(requests().filter((request) => request.prompt === "HOLD:existing").length, 1);
  } else if (phase === "dispose-wait") {
    const launched = await call(
      "delegate",
      {
        prompt: "HOLD:foreground",
        model: "single-agent-fixture/literal-model",
      },
      "detach-launch",
    );
    const id = launched.details.id;
    await until(
      () => requests().some((r) => r.prompt === "HOLD:foreground"),
      "held child actual readiness",
    );
    const waiting = session.agent.state.tools
      .find((t) => t.name === "agent_runs")
      .execute("admitted-detach-wait", { action: "wait", id }, new AbortController().signal);
    await runtime.dispose();
    const detached = await waiting;
    assert.equal(detached.details.wait, "detached");
    process.kill(requests()[0].pid, 0);
    assert.equal(fs.existsSync(path.join(runDir(id), "stop-acknowledged.json")), false);
    fs.writeFileSync(path.join(root, "release-foreground"), "release");
    await until(
      () => fs.existsSync(path.join(runDir(id), "result.json")),
      "detached producer actually finishes",
    );
    assert.equal(readJSON(path.join(runDir(id), "result.json")).status, "completed");
  } else if (phase === "parallel-cold-continue") {
    const initial = await call(
      "delegate",
      {
        prompt: "PARALLEL_SEED_LITERAL",
        model: "single-agent-fixture/literal-model",
        async: false,
      },
      "parallel-seed",
    );
    assert.equal(initial.isError, false, JSON.stringify(initial));
    const original = initial.details.id;
    const oldPid = requests()[0].pid;
    const oldIdentity = readJSON(path.join(runDir(original), "actor.lock/process.json"));
    process.kill(oldPid, "SIGKILL");
    await until(() => {
      try {
        process.kill(oldPid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    }, "prior actor actually exits before concurrent native continuations");
    await until(
      () => fs.existsSync(path.join(runDir(original), `exit-${oldIdentity.token}.json`)),
      "actual attached main process publishes the observed actor exit",
    );
    const exited = await call(
      "agent_runs",
      { action: "inspect", id: original },
      "known-process-exit",
    );
    assert.equal(exited.details.process.exitKnown, true);
    assert.equal(exited.details.process.exit.pid, oldPid);
    assert.equal(exited.details.process.exit.code, null);
    assert.equal(exited.details.process.exit.signal, "SIGKILL");
    assert.equal(
      exited.details.result.status,
      "completed",
      "process exit is independent of the canonical workflow result",
    );
    const spawnActor = childProcess.spawn;
    const replacements = [];
    childProcess.spawn = (...args) => {
      const child = spawnActor(...args);
      if (args[1]?.[0]?.endsWith("/agent/runner.js")) {
        replacements.push(child);
      }
      return child;
    };
    syncBuiltinESMExports();
    try {
      const ids = ["parallel-continue-one", "parallel-continue-two"];
      const prompts = ["HOLD:parallelfirst", "PARALLEL_SECOND_DISTINCT_LITERAL"];
      faux.setResponses([
        fauxAssistantMessage(
          ids.map((id, index) => ({
            type: "toolCall",
            id,
            name: "agent_runs",
            arguments: { action: "continue", id: original, prompt: prompts[index] },
          })),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("PARALLEL_NATIVE_BATCH_COMPLETE"),
      ]);
      await session.prompt("Run two cold continuations in the same native parallel tool batch");
      await session.waitForIdle();
      const receipts = ids.map((id) => {
        assert.equal(resultEntries(id).length, 1);
        return resultEntries(id)[0].message;
      });
      assert.equal(receipts[0].isError, false, JSON.stringify(receipts[0]));
      assert.equal(receipts[0].details.receipt, "continuation");
      assert.equal(
        receipts[1].isError,
        true,
        "a pending native admission must not accept and discard a distinct prompt",
      );
      assert.match(JSON.stringify(receipts[1].content), /awaiting native admission.*retry/i);
      const nativeStarts = () =>
        fs
          .readFileSync(path.join(root, "native-actor-starts.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
      await until(
        () =>
          replacements.every((child) => nativeStarts().some((entry) => entry.pid === child.pid)),
        "every actually spawned replacement reaches native SDK session startup",
      );
      const owners = new Set(
        nativeStarts()
          .filter((entry) => entry.sessionId === initial.details.sessionId && entry.pid !== oldPid)
          .map((entry) => entry.pid),
      );
      assert.equal(
        owners.size,
        1,
        "parallel native calls acquire exactly one native actor owner per journal",
      );
      assert.equal(replacements.length, 1, "exactly one replacement process was actually spawned");
      await until(
        () => requests().some((r) => r.prompt === prompts[0]),
        "replacement actor actually starts tracked work",
      );
      const first = readJSON(path.join(runDir(original), "successor.json")).id;
      assert.equal(
        first,
        receipts[0].details.id,
        "the only accepted successor claim remains canonical",
      );
      const launch = readJSON(path.join(runDir(first), "launch.json"));
      assert.equal(launch.id, first);
      assert.equal(launch.sessionFile, initial.details.sessionFile);
      assert.equal(launch.prompt, prompts[0]);
      assert.equal(
        fs.existsSync(path.join(runDir(first), "successor.json")),
        false,
        "pending work was not superseded",
      );
      assert.equal(requests().filter((r) => r.prompt === prompts[1]).length, 0);
      const identity = readJSON(path.join(runDir(original), "actor.lock/process.json"));
      const ready = readJSON(path.join(runDir(original), "ready.json"));
      assert.equal(identity.pid, replacements[0].pid);
      assert.equal(ready.pid, identity.pid);
      assert.equal(ready.token, identity.token);
      assert.notEqual(identity.pid, oldPid);
      fs.writeFileSync(path.join(root, "release-parallelfirst"), "release");
      const outcome = await call(
        "agent_runs",
        { action: "wait", id: original },
        "parallel-cold-result",
      );
      assert.equal(outcome.isError, false, JSON.stringify(outcome));
      assert.equal(outcome.details.id, first);
      assert.equal(
        outcome.details.result.status,
        "completed",
        "accepted B does not remain permanently pending",
      );
      assert.equal(outcome.details.output.text, `CHILD_LITERAL_RESULT:${prompts[0]}`);
      const observed = requests().filter((r) => r.prompt === prompts[0]);
      assert.equal(observed.length, 1);
      assert.equal(observed[0].pid, identity.pid);
      assert.equal(
        nativeStarts().find((entry) => entry.pid === observed[0].pid).sessionId,
        initial.details.sessionId,
      );
      const names = ["launch.json", "result.json", "output.txt"];
      const frozen = names.map((name) => fs.readFileSync(path.join(runDir(first), name)));
      const retry = await call(
        "agent_runs",
        {
          action: "continue",
          id: original,
          prompt: prompts[1],
          async: false,
        },
        "retry-distinct-parallel-prompt",
      );
      assert.equal(retry.isError, false, JSON.stringify(retry));
      assert.equal(retry.details.output.text, `CHILD_LITERAL_RESULT:${prompts[1]}`);
      assert.equal(retry.details.sessionFile, initial.details.sessionFile);
      assert.equal(readJSON(path.join(runDir(first), "successor.json")).id, retry.details.id);
      assert.equal(replacements.length, 1, "explicit retry keeps the same native actor owner");
      assert.deepEqual(
        requests()
          .filter((r) => prompts.includes(r.prompt))
          .map((r) => [r.prompt, r.pid]),
        [
          [prompts[0], identity.pid],
          [prompts[1], identity.pid],
        ],
        "each distinct accepted invocation executes exactly once; rejected intent executes only after explicit retry",
      );
      names.forEach((name, index) =>
        assert.deepEqual(fs.readFileSync(path.join(runDir(first), name)), frozen[index]),
      );
      const physical = fs
        .readFileSync(initial.details.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(physical.filter((entry) => entry.type === "session").length, 1);
      assert.equal(
        physical.filter((entry) => entry.id === outcome.details.result.terminalEntryId).length,
        1,
      );
    } finally {
      childProcess.spawn = spawnActor;
      syncBuiltinESMExports();
      fs.writeFileSync(path.join(root, "release-parallelfirst"), "release");
      await Promise.all(
        replacements.map(
          (child) =>
            new Promise((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
              }
              child.ref();
              child.once("exit", resolve);
              child.kill("SIGTERM");
            }),
        ),
      );
    }
  } else if (phase === "generation" || phase === "late-guidance") {
    const originalTimeout = globalThis.setTimeout;
    if (phase === "generation") {
      globalThis.setTimeout = (callback, ms, ...args) =>
        originalTimeout(() => {
          callback(...args);
          if (ms === 3000) {
            fs.writeFileSync(path.join(root, "escalation-processed"), "done");
          }
        }, ms);
    }
    const first = await call(
      "delegate",
      { prompt: "HOLD:boundary", model: "single-agent-fixture/literal-model" },
      "boundary-launch",
    );
    const id = first.details.id;
    await until(() => requests().some((r) => r.prompt === "HOLD:boundary"), "old turn starts");
    let stopped;
    if (phase === "generation") {
      const oldPid = requests()[0].pid;
      const oldActor = readJSON(path.join(runDir(id), "actor.lock/process.json"));
      const link = fs.linkSync;
      let heldStop;
      fs.linkSync = (source, destination) => {
        if (
          path.dirname(destination) === path.join(runDir(id), "commands") &&
          readJSON(source).action === "stop"
        ) {
          assert.equal(heldStop, undefined, "one actual Stop publication is held");
          heldStop = { file: path.join(runDir(id), "unpublished-stop.json"), destination };
          return link(source, heldStop.file);
        }
        return link(source, destination);
      };
      syncBuiltinESMExports();
      try {
        stopped = await call("agent_runs", { action: "stop", id }, "stop-old-generation");
      } finally {
        fs.linkSync = link;
        syncBuiltinESMExports();
      }
      assert.ok(heldStop, "the registered tool produced a real durable Stop record");
      assert.equal(fs.existsSync(heldStop.file), true, "original Stop bytes remain on disk");
      assert.equal(
        fs.existsSync(heldStop.destination),
        false,
        "Stop is not yet visible to the command reader",
      );
      const heldBytes = fs.readFileSync(heldStop.file);
      await until(() => fs.existsSync(path.join(runDir(id), "result.json")), "old stop settles");
      await until(() => {
        try {
          process.kill(oldPid, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      }, "old actor actually exits before replacement");
      assert.equal(
        fs.existsSync(path.join(runDir(id), "admissions", `${stopped.details.stopRequest}.json`)),
        false,
        "observed old actor exit establishes that it cannot admit the held Stop",
      );
      assert.equal(
        heldStop.destination,
        path.join(runDir(id), "commands", `${stopped.details.stopRequest}.json`),
      );
      // Publish the exact tool-produced record only after the predecessor cannot read it.
      fs.linkSync(heldStop.file, heldStop.destination);
      fs.unlinkSync(heldStop.file);
      assert.deepEqual(fs.readFileSync(heldStop.destination), heldBytes);
      assert.equal(
        readJSON(path.join(runDir(id), "commands", `${stopped.details.stopRequest}.json`))
          .actorToken,
        oldActor.token,
        "Stop is bound to the verified actor generation",
      );
      await until(
        () => fs.existsSync(path.join(runDir(id), `exit-${oldActor.token}.json`)),
        "launcher publishes the old actor's actual exit event",
      );
      const exited = await call("agent_runs", { action: "inspect", id }, "old-exit-inspect");
      assert.equal(exited.details.process.live, false);
      assert.equal(exited.details.process.exitKnown, true);
      assert.equal(exited.details.process.exit.code, 0);
      assert.ok(
        exited.content.some((block) =>
          block.text?.includes("Process exit observed: code 0, signal none."),
        ),
        "model sees the observed process exit rather than inferring it from completion",
      );
      fs.writeFileSync(
        path.join(runDir(id), "commands/legacy-unbound-stop.json"),
        JSON.stringify({
          id: "legacy-unbound-stop",
          runId: id,
          action: "stop",
          createdAt: Date.now(),
        }),
      );
    } else {
      const link = fs.linkSync;
      fs.linkSync = (source, destination) => {
        if (destination.includes("/commands/") && readJSON(source).action === "steer") {
          fs.writeFileSync(path.join(root, "release-boundary"), "release");
          const waited = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
            import fs from 'node:fs';
            const file = ${JSON.stringify(path.join(runDir(id), "result.json"))};
            const end = Date.now() + 10000;
            while (!fs.existsSync(file) && Date.now() < end) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
            if (!fs.existsSync(file)) process.exit(1);
          `,
            ],
            { encoding: "utf8", timeout: 12000 },
          );
          assert.equal(waited.status, 0, waited.stderr);
          fs.linkSync = link;
          syncBuiltinESMExports();
        }
        return link(source, destination);
      };
      syncBuiltinESMExports();
      const stale = await call(
        "agent_runs",
        {
          action: "continue",
          id,
          prompt: "LATE_MUST_NOT_START",
          async: false,
        },
        "late-boundary",
      );
      assert.equal(stale.isError, false);
      assert.equal(stale.details.guidance, "stale");
      assert.equal(stale.details.receivedResult, undefined);
      assert.equal(
        requests().some((r) => r.prompt === "LATE_MUST_NOT_START"),
        false,
      );
      const inspected = await call("agent_runs", { action: "inspect", id }, "stale-admission");
      assert.equal(inspected.details.guidance.at(-1).state, "stale");
      const text = inspected.content.map((block) => block.text ?? "").join("\n");
      assert.ok(
        text.includes(`${stale.details.command}: stale`),
        "model sees the guidance command ID and its actual rejection state",
      );
      assert.match(text, /stale.*no new work was started/i);
      assert.match(text, /accepted.*not.*(publication|consumption)/i);
      assert.match(text, /pending.*not.*admitted/i);
      assert.match(text, /receipt.*(published|not observed)/i);
      assert.match(text, /exit.*(unknown|code)/i);
      if (inspected.details.nativeReceipt === null) {
        assert.match(text, /Native completion receipt: not observed published/);
      } else {
        assert.ok(
          text.includes(
            `Native completion receipt: published (${inspected.details.nativeReceipt})`,
          ),
        );
      }
      assert.match(text, /Process exit: unknown; run completion does not imply process exit/);
    }
    const frozen = ["launch.json", "result.json", "output.txt"].map((name) =>
      fs.readFileSync(path.join(runDir(id), name)),
    );
    const oldPid = requests()[0].pid;
    const next = await call(
      "agent_runs",
      {
        action: "continue",
        id,
        prompt: "HOLD:replacement",
      },
      "replacement-launch",
    );
    assert.equal(next.isError, false, JSON.stringify(next));
    assert.notEqual(next.details.id, id);
    await until(() => requests().some((r) => r.prompt === "HOLD:replacement"), "replacement ready");
    if (phase === "generation") {
      assert.notEqual(requests().at(-1).pid, oldPid);
      await until(
        () => fs.existsSync(path.join(root, "escalation-processed")),
        "old timer actually ran",
      );
      const live = await call(
        "agent_runs",
        { action: "inspect", id: next.details.id },
        "after-old-timer",
      );
      assert.equal(live.details.process.live, true, "old timer cannot kill new actor generation");
      assert.equal(live.details.completed, false);
      assert.equal(
        readJSON(path.join(runDir(id), "admissions", `${stopped.details.stopRequest}.json`)).state,
        "stale",
      );
      assert.equal(
        readJSON(path.join(runDir(id), "admissions/legacy-unbound-stop.json")).state,
        "stale",
        "pre-upgrade unbound Stops cannot stop a replacement either",
      );
    }
    fs.writeFileSync(path.join(root, "release-replacement"), "release");
    const outcome = await call(
      "agent_runs",
      { action: "wait", id: next.details.id },
      "replacement-result",
    );
    assert.equal(outcome.details.output.text, "CHILD_LITERAL_RESULT:HOLD:replacement");
    assert.equal(outcome.details.status, "completed", "old Stop must not mark successor stopped");
    ["launch.json", "result.json", "output.txt"].forEach((name, index) =>
      assert.deepEqual(fs.readFileSync(path.join(runDir(id), name)), frozen[index]),
    );
    globalThis.setTimeout = originalTimeout;
  } else if (phase === "continuation") {
    manager.appendMessage({
      role: "user",
      content: "A literal inherited calibration result",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "earlier-call",
          name: "delegate",
          arguments: { prompt: "calibrate" },
        },
      ],
      provider: faux.getModel().provider,
      model: faux.getModel().id,
      api: faux.getModel().api,
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "earlier-call",
      toolName: "delegate",
      content: [{ type: "text", text: "CALIBRATION_7391" }],
      isError: false,
      timestamp: Date.now(),
    });
    session.refreshContext();
    const first = await call(
      "delegate",
      {
        prompt: "RECALL_LITERAL",
        model: "single-agent-fixture/literal-model",
        context: "fork",
        async: false,
      },
      "fork-calibration",
    );
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal(first.details.result.status, "completed");
    assert.equal(first.details.output.text, "RECALLED_CALIBRATION_7391");
    const saved = readJSON(path.join(runDir(first.details.id), "launch.json"));
    const second = await call(
      "agent_runs",
      { action: "continue", id: first.details.id, prompt: "HOLD:second", async: true },
      "continue-one",
    );
    assert.notEqual(second.details.id, first.details.id);
    await until(
      () => requests().some((request) => request.prompt === "HOLD:second"),
      "continuation is in native provider",
    );
    const childPid = requests().find((request) => request.prompt === "HOLD:second").pid;
    process.kill(childPid, "SIGSTOP");
    let guidance;
    try {
      guidance = await call(
        "agent_runs",
        { action: "continue", id: first.details.id, prompt: "GUIDANCE_LITERAL" },
        "continue-original",
      );
      const pending = await call(
        "agent_runs",
        { action: "inspect", id: second.details.id },
        "guidance-pending-inspect",
      );
      const pendingText = pending.content.map((block) => block.text ?? "").join("\n");
      assert.ok(pendingText.includes(`${guidance.details.command}: pending`));
      assert.match(pendingText, /pending.*not yet admitted/);
    } finally {
      process.kill(childPid, "SIGCONT");
    }
    assert.equal(guidance.details.id, second.details.id);
    assert.equal(guidance.details.receipt, "guidance");
    assert.equal(guidance.details.sessionId, saved.sessionId);
    assert.equal(guidance.details.model, "single-agent-fixture/literal-model");
    const guidanceAdmission = path.join(
      runDir(first.details.id),
      "admissions",
      `${guidance.details.command}.json`,
    );
    await until(
      () => fs.existsSync(guidanceAdmission),
      "actual actor admits live guidance before releasing held turn",
    );
    assert.equal(readJSON(guidanceAdmission).state, "accepted");
    const accepted = await call(
      "agent_runs",
      { action: "inspect", id: second.details.id },
      "guidance-accepted-inspect",
    );
    const acceptedText = accepted.content.map((block) => block.text ?? "").join("\n");
    assert.ok(acceptedText.includes(`${guidance.details.command}: accepted`));
    assert.match(
      acceptedText,
      /accepted.*queue admission, not journal publication or model consumption/,
    );
    const nextSaved = readJSON(path.join(runDir(second.details.id), "launch.json"));
    for (const field of [
      "sessionId",
      "sessionFile",
      "provider",
      "model",
      "thinking",
      "context",
      "cwd",
    ]) {
      assert.deepEqual(nextSaved[field], saved[field]);
    }
    fs.writeFileSync(path.join(root, "release-second"), "release");
    await until(
      () => fs.existsSync(path.join(runDir(second.details.id), "result.json")),
      "successor result publishes",
    );
    assert.equal(
      requests().some((request) => request.prompt === "GUIDANCE_LITERAL"),
      true,
    );
    assert.equal(
      fs.readFileSync(path.join(runDir(second.details.id), "output.txt"), "utf8"),
      "CHILD_LITERAL_RESULT:GUIDANCE_LITERAL",
      "accepted guidance remains inside the tracked native turn outcome",
    );
    assert.equal(new Set(requests().map((request) => request.pid)).size, 1);
    const long = await call(
      "delegate",
      { prompt: "LONG_LITERAL", model: "single-agent-fixture/literal-model", async: false },
      "long-output",
    );
    let output = long.details.output.text,
      offset = long.details.output.nextOffset;
    while (offset !== undefined) {
      // Each next page depends on the preceding native tool receipt's byte cursor.
      // oxlint-disable-next-line no-await-in-loop
      const page = await call(
        "agent_runs",
        { action: "inspect", id: long.details.id, offset },
        `page-${offset}`,
      );
      output += page.details.output.text;
      offset = page.details.output.nextOffset;
    }
    assert.equal(output, "😀雪".repeat(20000) + "END_LITERAL");
    const failure = await call(
      "delegate",
      { prompt: "FAIL_LITERAL", model: "single-agent-fixture/literal-model", async: false },
      "model-failure",
    );
    assert.equal(failure.isError, true);
    assert.equal(failure.details.output.text, "ERROR_PARTIAL_LITERAL");
    assert.equal(failure.details.result.error, "CONTROLLED_MODEL_FAILURE");
    const emitted = toolEnds.find((event) => event.toolCallId === "model-failure");
    assert.equal(emitted.isError, true);
    assert.deepEqual(emitted.result.content, failure.content);
    assert.deepEqual(emitted.result.details, failure.details);
    const reopened = sdk.SessionManager.open(manager.getSessionFile())
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === "model-failure",
      ).message;
    assert.equal(reopened.isError, emitted.isError);
    assert.deepEqual(reopened.content, emitted.result.content);
    assert.deepEqual(reopened.details, JSON.parse(JSON.stringify(emitted.result.details)));
    const nested = await call(
      "delegate",
      { prompt: "NESTED_LITERAL", model: "single-agent-fixture/literal-model", async: false },
      "nested-policy",
    );
    assert.equal(nested.isError, false);
    assert.equal(readJSON(path.join(root, "nested-result.json")).isError, true);
    assert.equal(
      requests().some((request) => request.prompt === "UNAUTHORIZED_NESTED_CHILD"),
      false,
    );
    const foreign = sdk.SessionManager.create(cwd, path.join(root, "foreign"));
    assert.notEqual(foreign.getSessionId(), manager.getSessionId());
    fs.writeFileSync(
      path.join(root, "continuation-evidence.json"),
      JSON.stringify({
        entries: manager.getEntries(),
        requests: requests(),
        foreignId: foreign.getSessionId(),
      }),
    );
  } else {
    throw new Error(`Unknown phase ${phase}`);
  }
  assert.deepEqual(errors, []);
  assert.equal(networkRequests, 0);
} finally {
  await session.abort();
  await runtime.dispose();
  fs.writeFileSync(
    path.join(root, `${phase}-evidence.json`),
    JSON.stringify({
      pid: process.pid,
      errors,
      networkRequests,
      entries: manager.getEntries(),
      requests: requests(),
    }),
  );
}
