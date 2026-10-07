import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nativeSdkRoot } from "../support/native-sdk.ts";
import { assertDefined, parseJson } from "../support/assertions.ts";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "../../src/runs/shared/structured-output.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

nativeSdkRoot(process.env.PI_INTERCOM_TEST_SDK);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import("@earendil-works/pi-coding-agent");
const {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  getCurrentTools,
} = await import("@earendil-works/pi-ai");

test("a no-schema child launch cannot install a tool that writes its parent's structured capture", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "native-structured-child-"));
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  });
  const parentCapture = path.join(root, "parent-output.json");
  const parentSchema = path.join(root, "parent-schema.json");
  writeFileSync(parentCapture, "parent-only");
  writeFileSync(parentSchema, JSON.stringify({ type: "object", properties: {} }));
  Object.assign(process.env, {
    HOME: root,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_OFFLINE: "1",
    [STRUCTURED_OUTPUT_CAPTURE_ENV]: parentCapture,
    [STRUCTURED_OUTPUT_SCHEMA_ENV]: parentSchema,
    MCP_DIRECT_TOOLS: "inherited-selection",
  });
  const { env } = buildPiArgs({
    baseArgs: ["-p"],
    task: "Ordinary helper",
    sessionEnabled: false,
    inheritProjectContext: false,
    inheritSkills: false,
  });
  Object.assign(process.env, env);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [path.resolve("src/runs/shared/subagent-prompt-runtime.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.ok(
    !loader
      .getExtensions()
      .extensions.some((extension) => extension.tools.has("structured_output")),
    "helper must not register its parent's structured_output tool",
  );
  assert.equal(process.env[STRUCTURED_OUTPUT_CAPTURE_ENV], "");
  assert.equal(process.env[STRUCTURED_OUTPUT_SCHEMA_ENV], "");
  assert.equal(
    process.env.MCP_DIRECT_TOOLS,
    "inherited-selection",
    "unrelated environment inheritance is preserved",
  );
  assert.equal(readFileSync(parentCapture, "utf8"), "parent-only");
});

for (const explicit of [false, true]) {
  test(`resumed structured output reaches the provider and captures its report (${explicit ? "explicit tools" : "saved tools"})`, async (t) => {
    const evidenceDir = process.env.PI_INTERCOM_TEST_EVIDENCE_DIR;
    if (evidenceDir !== undefined && evidenceDir !== "") {
      mkdirSync(evidenceDir, { recursive: true });
    }
    const root = mkdtempSync(path.join(evidenceDir ?? tmpdir(), "native-structured-output-"));
    const previous = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PI_SUBAGENT_")) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, {
      HOME: root,
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
      PI_OFFLINE: "1",
    });
    t.after(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
      if (evidenceDir === undefined || evidenceDir === "") {
        rmSync(root, { recursive: true, force: true });
      }
    });
    const faux = fauxProvider({ provider: "structured-output-resume" });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loaderOptions = {
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    };
    const initialLoader = new DefaultResourceLoader(loaderOptions);
    await initialLoader.reload();
    const { session: initial } = await createAgentSession({
      cwd: root,
      modelRuntime,
      model: faux.getModel(),
      settingsManager,
      resourceLoader: initialLoader,
      sessionManager: SessionManager.create(root, path.join(root, "sessions")),
      tools: ["read"],
    });
    faux.setResponses([fauxAssistantMessage("Initial work finished")]);
    await initial.prompt("Perform initial work");
    initial.sessionManager.appendCustomMessageEntry(
      "subagent-notify",
      "PARENT_ONLY_NOTIFICATION",
      false,
    );
    const sessionFile = initial.sessionManager.getSessionFile();
    assertDefined(sessionFile);
    initial.dispose();

    const output = path.join(root, "report.json");
    process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = output;
    process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = path.join(root, "schema.json");
    writeFileSync(
      process.env[STRUCTURED_OUTPUT_SCHEMA_ENV],
      JSON.stringify({
        type: "object",
        properties: { report: { type: "string" } },
        required: ["report"],
      }),
    );
    const loader = new DefaultResourceLoader({
      ...loaderOptions,
      additionalExtensionPaths: [
        process.env.PI_STRUCTURED_OUTPUT_TEST_EXTENSION ??
          path.resolve("src/runs/shared/subagent-prompt-runtime.ts"),
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: root,
      modelRuntime,
      model: faux.getModel(),
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.open(sessionFile),
      ...(explicit ? { tools: ["read", "structured_output"] } : {}),
    });
    t.after(async () => {
      await session.abort();
      session.dispose();
    });
    const restoredTools = session.getActiveToolNames();
    t.diagnostic(`Native restored tools before extension startup: ${restoredTools.join(", ")}`);
    await session.bindExtensions({ mode: "print" });
    let providerTools: string[] = [];
    let providerMessages: readonly unknown[] = [];
    faux.setResponses([
      (context) => {
        providerTools = getCurrentTools(context.messages).map((tool) => tool.name);
        providerMessages = context.messages;
        return fauxAssistantMessage(
          fauxToolCall("structured_output", { value: { report: "Verified final report" } }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("Done"),
    ]);
    await session.prompt("Submit the final report");
    assert.match(
      JSON.stringify(providerMessages),
      /Initial work finished/,
      "saved conversation survives context filtering",
    );
    assert.doesNotMatch(
      JSON.stringify(providerMessages),
      /PARENT_ONLY_NOTIFICATION/,
      "parent-only history is excluded from the child request",
    );
    assert.ok(
      session.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom_message" && entry.content === "PARENT_ONLY_NOTIFICATION",
        ),
      "filtering must not rewrite saved history",
    );
    assert.ok(
      providerTools.includes("structured_output"),
      "resumed provider request must advertise structured_output",
    );
    assert.ok(providerTools.includes("read"), "existing tool selection survives");
    assert.deepEqual(
      providerTools.sort((a, b) => a.localeCompare(b)),
      [...new Set([...restoredTools, "structured_output"])].sort((a, b) => a.localeCompare(b)),
      "startup activation must preserve the host's restored selection without enabling unrelated tools",
    );
    if (explicit) {
      assert.deepEqual(providerTools, ["read", "structured_output"]);
    }
    assert.deepEqual(parseJson(readFileSync(output, "utf8")), { report: "Verified final report" });
  });
}
