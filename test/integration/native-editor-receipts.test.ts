import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nativeSdkRoot } from "../support/native-sdk.ts";
import { array, record, records } from "../support/assertions.ts";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";

const editor = process.env.PI_EDITOR_RECEIPT_TEST_ROOT;
test(
  "actual editor receipts survive the single extension through native publication",
  { skip: editor === undefined || editor === "", timeout: 30_000 },
  async (t) => {
    assert.ok(editor !== undefined && editor !== "", "actual native editor checkout is configured");
    const sdkRoot = nativeSdkRoot(process.env.PI_EDITOR_RECEIPT_TEST_SDK);
    const sdk = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } =
      await import("@earendil-works/pi-ai");
    const evidenceRoot = process.env.PI_EDITOR_RECEIPT_EVIDENCE_DIR;
    if (evidenceRoot !== undefined && evidenceRoot !== "") {
      fs.mkdirSync(evidenceRoot, { recursive: true });
    }
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(evidenceRoot ?? os.tmpdir(), "native-editor-receipts-")),
    );
    for (const file of ["a", "b", "c"]) {
      fs.writeFileSync(path.join(cwd, file), "before\n");
    }
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({ provider: "editor-receipt-fixture" });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir: cwd,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noThemes: true,
        noPromptTemplates: true,
        additionalExtensionPaths: [
          path.resolve("src/index.ts"),
          path.join(editor, "extensions/apply-edits.ts"),
        ],
        extensionsOverride(base) {
          for (const extension of base.extensions) {
            for (const { definition } of extension.tools.values()) {
              if (definition.name !== "write_files") {
                continue;
              }
              const execute = definition.execute.bind(definition);
              definition.execute = async (
                id: string,
                params: unknown,
                signal: AbortSignal | undefined,
                update: AgentToolUpdateCallback<unknown> | undefined,
                ctx: ExtensionToolContext,
              ) => {
                if (array(record(params).files).length !== 3) {
                  return execute(id, params, signal, update, ctx);
                }
                const cancellation = new AbortController();
                return execute(
                  id,
                  params,
                  cancellation.signal,
                  (progress) => {
                    update?.(progress);
                    if (
                      progress.content.some(
                        (part) => part.type === "text" && part.text.startsWith("Completed 1/"),
                      )
                    ) {
                      cancellation.abort();
                    }
                  },
                  ctx,
                );
              };
            }
          }
          return base;
        },
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const manager = sdk.SessionManager.create(cwd, path.join(cwd, "sessions"));
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
        cwd,
        agentDir: cwd,
        sessionManager: manager,
      },
    );
    const { session } = runtime;
    const errors: unknown[] = [];
    const receipts: ToolResultMessage[] = [];
    await session.bindExtensions({
      mode: "json",
      onError: (error) => {
        errors.push(error);
      },
    });
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "toolResult") {
        receipts.push(event.message);
      }
    });
    t.after(async () => {
      await session.abort();
      await runtime.dispose();
      if (evidenceRoot === undefined || evidenceRoot === "") {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
    const calls: Array<readonly [string, ToolCall["arguments"]]> = [
      ["preview_patch", { input: "*** Begin Patch\n*** Add File: planned\n+never\n*** End Patch" }],
      [
        "write_files",
        { files: [{ path: "a", content: "preview\n", mode: "replace" }], preview: true },
      ],
      [
        "write_files",
        {
          files: ["a", "b", "c"].map((file) => ({
            path: file,
            content: "after\n",
            mode: "replace",
          })),
        },
      ],
      ["write_files", { files: [{ path: "a", content: "after\n", mode: "replace" }] }],
      [
        "replace_text",
        { files: [{ path: "c", edits: [{ oldText: "before", newText: "changed" }] }] },
      ],
      ["apply_patch", { input: "*** Begin Patch\n*** Add File: added\n+verified\n*** End Patch" }],
    ];
    faux.setResponses([
      ...calls.map(([name, args]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
      ),
      fauxAssistantMessage("Fixture complete"),
    ]);
    await session.prompt("Execute the controlled editor fixtures");
    assert.deepEqual(errors, []);
    assert.equal(receipts.length, 6);
    assert.deepEqual(
      receipts.map((receipt) => receipt.isError),
      [false, false, true, false, false, false],
    );
    assert.equal(
      receipts[2].isError,
      true,
      "native error hook preserves the real partial-publication error",
    );
    assert.deepEqual(record(receipts[2].details).modifiedFiles, [path.join(cwd, "a")]);
    assert.deepEqual(
      records(record(receipts[2].details).files).map((file) => file.status),
      ["applied", "failed", "unattempted"],
    );
    assert.equal(records(record(receipts[3].details).files)[0].status, "unchanged");
    const published = sdk.SessionManager.open(manager.getSessionFile() ?? "")
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
    assert.equal(published.length, 6, "actual native tool results are published, not just emitted");
    assert.equal(fs.existsSync(path.join(cwd, "planned")), false);
    assert.equal(fs.readFileSync(path.join(cwd, "b"), "utf8"), "before\n");
    assert.equal(fs.readFileSync(path.join(cwd, "added"), "utf8"), "verified\n");
    const consumer = new URL("../../src/index.ts", import.meta.url);
    fs.writeFileSync(
      path.join(cwd, "evidence.json"),
      JSON.stringify(
        {
          sdkRoot,
          editor,
          editorCommit: execFileSync("git", ["-C", editor, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          consumerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          consumerSha256: createHash("sha256").update(fs.readFileSync(consumer)).digest("hex"),
          receipts,
        },
        null,
        2,
      ),
    );
    t.diagnostic(`Actual native editor receipt evidence: ${cwd}`);
  },
);
