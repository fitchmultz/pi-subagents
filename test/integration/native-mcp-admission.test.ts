import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";
import { nativeCli } from "../support/native-sdk.ts";
import {
  assertRecord,
  parseJson,
  readJson,
  records,
  strings,
  text,
} from "../support/assertions.ts";

const cli = nativeCli(process.env.PI_MCP_TEST_HOST);
const adapter = process.env.PI_MCP_ADAPTER_TEST_ROOT;
const driver = fileURLToPath(new URL("../fixtures/native-mcp-admission.ts", import.meta.url));

async function child(input: {
  root: string;
  tools?: readonly string[];
  selections?: readonly string[];
  extensions?: readonly string[];
  extraArgs?: readonly string[];
  target?: string;
  collision?: boolean;
  followup?: boolean;
  inactive?: boolean;
  inheritedSelection?: string;
}) {
  const output = path.join(input.root, "receipt.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(input.root, "agent");
  const built = buildPiArgs({
    baseArgs: [
      "--offline",
      "--mode",
      "json",
      "--no-prompt-templates",
      "--no-themes",
      ...(input.extraArgs ?? []),
    ],
    model: "faux/faux-1",
    task: "Exercise local admission, not an external model",
    cwd: path.join(input.root, "project"),
    sessionEnabled: false,
    inheritProjectContext: false,
    inheritSkills: false,
    tools: input.tools,
    mcpDirectTools: input.selections,
    extensions: [...(input.extensions ?? []), driver],
    projectTrust: "approve",
  });
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const executing = execFile(
        process.execPath,
        [cli, ...built.args],
        {
          cwd: path.join(input.root, "project"),
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: input.root,
            USERPROFILE: input.root,
            PI_CODING_AGENT_DIR: path.join(input.root, "agent"),
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
            MCP_DIRECT_TOOLS: input.inheritedSelection,
            ...built.env,
            MCP_ADMISSION_RECEIPT: output,
            MCP_ADMISSION_TARGET: input.target,
            MCP_ADMISSION_COLLISION: input.collision === true ? "1" : "0",
            MCP_ADMISSION_FOLLOWUP: input.followup === true ? "1" : "0",
            MCP_ADMISSION_INACTIVE: input.inactive === true ? "1" : "0",
          },
        },
        (error, stdout, stderr) => {
          if (error !== null && typeof error.code !== "number") {
            reject(new Error(error.message, { cause: error }));
            return;
          }
          resolve({ code: Number(error?.code ?? 0), stdout, stderr });
        },
      );
      executing.stdin?.end();
    },
  );
  const receipt = readJson(output);
  assertRecord(receipt);
  const index = built.args.indexOf("--tools");
  return { ...result, receipt, allowlist: index < 0 ? undefined : built.args[index + 1] };
}

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-admission-"));
  fs.mkdirSync(path.join(directory, "project"));
  return directory;
}

it("ordinary standalone child is not blocked by an inherited adapter selection", async () => {
  const directory = root();
  try {
    const result = await child({
      root: directory,
      inheritedSelection: "unavailable-parent-server",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.receipt.providerCalls, 1);
    assert.ok(strings(result.receipt.active).includes("read"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("missing adapter ownership fails with no hints and with actual leftover name hints", async () => {
  const directory = root();
  try {
    const cacheDir = path.join(directory, "agent", "fitch-mcp-adapter");
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const cached of [false, true]) {
      if (cached) {
        fs.writeFileSync(
          path.join(cacheDir, "mcp.json"),
          JSON.stringify({ mcpServers: { demo: { command: "fitch-fixture" } } }),
        );
        fs.writeFileSync(
          path.join(cacheDir, "mcp-cache.json"),
          JSON.stringify({
            version: 1,
            servers: {
              demo: {
                configHash: "43f0e396219a77e81b9f5d9602f5554eb2e84d89dca63b9a05490dfc7e6ebd8c",
                cachedAt: Date.now(),
                tools: [{ name: "echo" }],
              },
            },
          }),
        );
      }
      // Test-owned files supply the hints; no adapter is loaded in either launch.
      // oxlint-disable-next-line no-await-in-loop
      const result = await child({
        root: directory,
        tools: cached ? ["read"] : undefined,
        selections: ["demo/echo"],
        extraArgs: cached ? [] : ["Another launch input must remain blocked"],
      });
      assert.equal(result.allowlist, cached ? "read,demo_echo" : undefined);
      assert.equal(result.code, 1, result.stderr);
      assert.equal(
        result.stderr.match(/^Subagent MCP selection unavailable:/gm)?.length,
        cached ? 1 : 2,
      );
      assert.match(result.stderr, /mcp:demo\/echo/);
      assert.match(result.stderr, /exclude pi-mcp-adapter/);
      assert.equal(result.receipt.providerCalls, 0);
      assert.deepEqual(result.receipt.owners, []);
      assert.ok(!strings(result.receipt.active).includes("demo_echo"));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it(
  "real adapter publication, noncanonical config, exclusions and native MCP receipts",
  {
    skip:
      adapter === undefined && "Set PI_MCP_ADAPTER_TEST_ROOT for optional adapter qualification",
  },
  async () => {
    assert.ok(adapter !== undefined);
    const directory = root();
    const effects: string[] = [];
    const serve = async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      const message = parseJson(body);
      assertRecord(message);
      const method = text(message.method);
      if (method.startsWith("notifications/")) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (method === "server/discover") {
        result = {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        };
      } else if (method === "initialize") {
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      } else if (method === "tools/list") {
        result = {
          resultType: "complete",
          ttlMs: 1000,
          cacheScope: "private",
          tools: [
            {
              name: "echo",
              description: "Local echo",
              inputSchema: { type: "object", properties: { value: { type: "string" } } },
            },
          ],
        };
      } else if (method === "tools/call") {
        assertRecord(message.params);
        effects.push(text(message.params.name));
        result = { resultType: "complete", content: [{ type: "text", text: "LOCAL_MCP_RECEIPT" }] };
      } else if (method === "resources/list") {
        result = { resultType: "complete", resources: [] };
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    const server = createServer((request, response) => {
      void serve(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(JSON.stringify(error)));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const config = {
      mcpServers: {
        demo: { url: `http://127.0.0.1:${address.port}/mcp`, auth: false, lifecycle: "lazy" },
      },
      settings: { sampling: false, elicitation: false },
    };
    const cacheDir = path.join(directory, "agent", "fitch-mcp-adapter");
    const configFile = path.join(cacheDir, "mcp.json");
    const cacheFile = path.join(cacheDir, "mcp-cache.json");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config));
    const extension = path.join(adapter, "dist", "index.js");
    const invoke = (extra: Partial<Parameters<typeof child>[0]> = {}) =>
      child({
        root: directory,
        selections: ["demo/echo"],
        extensions: [extension],
        ...extra,
      });
    const registration = (result: Awaited<ReturnType<typeof child>>, name = "demo_echo") =>
      records(result.receipt.registered).find((tool) => tool.name === name);
    const published = (result: Awaited<ReturnType<typeof child>>, name = "demo_echo") => {
      assert.ok(strings(result.receipt.active).includes(name), JSON.stringify(result.receipt));
      assert.equal(registration(result, name)?.namespace, "mcp_demo");
      assert.equal(registration(result, name)?.owner, extension);
    };
    try {
      const cold = await invoke({ target: "demo_echo" });
      assert.equal(cold.code, 0, JSON.stringify(cold));
      published(cold);
      assert.match(cold.stdout, /LOCAL_MCP_RECEIPT/);
      assert.deepEqual(effects.splice(0), ["echo"]);
      assert.ok(fs.existsSync(cacheFile));

      for (const source of ["agents-global", "partial-override"]) {
        if (source === "agents-global") {
          fs.mkdirSync(path.join(directory, ".agents"));
          fs.writeFileSync(path.join(directory, ".agents", "mcp.json"), JSON.stringify(config));
          fs.writeFileSync(configFile, JSON.stringify({ ...config, mcpServers: {} }));
        } else {
          fs.rmSync(path.join(directory, ".agents"), { recursive: true });
          fs.writeFileSync(configFile, JSON.stringify(config));
          fs.writeFileSync(
            path.join(directory, "project", ".mcp.json"),
            JSON.stringify({ mcpServers: { demo: { lifecycle: "lazy", idleTimeout: 5 } } }),
          );
        }
        // Each real adapter reads its own valid configuration and publishes its tools.
        // oxlint-disable-next-line no-await-in-loop
        const alternate = await invoke({
          target: "demo_echo",
          selections: source === "partial-override" ? ["demo"] : ["demo/echo"],
        });
        published(alternate);
        assert.equal(alternate.allowlist, undefined);
        assert.equal(alternate.code, 0, `${source}: ${JSON.stringify(alternate)}`);
        assert.match(alternate.stdout, /LOCAL_MCP_RECEIPT/);
        assert.deepEqual(effects.splice(0), ["echo"]);
      }
      fs.rmSync(path.join(directory, "project", ".mcp.json"));

      const cache = readJson(cacheFile);
      assertRecord(cache);
      assertRecord(cache.servers);
      assertRecord(cache.servers.demo);
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ ...cache, servers: { demo: { ...cache.servers.demo, cachedAt: 1 } } }),
      );
      const stale = await invoke({ tools: ["read"] });
      assert.equal(stale.allowlist, "read");
      assert.ok(strings(stale.receipt.owners).includes(extension));
      assert.ok(!strings(stale.receipt.active).includes("demo_echo"));
      assert.equal(stale.code, 1, stale.stderr);
      assert.equal(stale.receipt.providerCalls, 0);
      assert.deepEqual(effects, []);

      const mixed = await invoke({ tools: ["read"], selections: ["demo"], target: "demo_echo" });
      published(mixed);
      assert.equal(mixed.allowlist, "read,demo_echo");
      assert.equal(mixed.code, 0, mixed.stderr);
      assert.match(mixed.stdout, /LOCAL_MCP_RECEIPT/);
      assert.deepEqual(effects.splice(0), ["echo"]);

      for (const mode of ["inactive", "partial", "collision"]) {
        // Native admission observations precede assertions about each distinct denial.
        // oxlint-disable-next-line no-await-in-loop
        const denied = await invoke({
          selections: mode === "partial" ? ["demo/echo", "demo/absent"] : ["demo/echo"],
          collision: mode === "collision",
          inactive: mode === "inactive",
        });
        assert.ok(strings(denied.receipt.owners).includes(extension));
        if (mode === "inactive") {
          assert.ok(!strings(denied.receipt.active).includes("demo_echo"));
          assert.equal(registration(denied)?.namespace, "mcp_demo");
          assert.equal(registration(denied)?.owner, extension);
        } else if (mode === "partial") {
          published(denied);
        } else {
          assert.ok(strings(denied.receipt.active).includes("demo_echo"));
          assert.equal(registration(denied)?.owner, driver);
          assert.equal(registration(denied)?.namespace, undefined);
        }
        assert.equal(denied.code, 1, `${mode}: ${JSON.stringify(denied.receipt)}`);
        assert.match(denied.stderr, /^Subagent MCP selection unavailable:/m);
        assert.equal(denied.receipt.providerCalls, 0);
        assert.deepEqual(effects, []);
      }

      const followup = await invoke({ followup: true });
      published(followup);
      assert.equal(followup.code, 0, JSON.stringify(followup));
      assert.equal(followup.receipt.providerCalls, 2);
      assert.ok(strings(followup.receipt.inputs).includes("extension"));
      assert.match(followup.stdout, /FOLLOWUP_DELIVERED/);

      fs.writeFileSync(
        configFile,
        JSON.stringify({ ...config, settings: { ...config.settings, toolPrefix: "mcp" } }),
      );
      const prefixed = await invoke({ tools: ["read"], target: "mcp__demo_echo" });
      published(prefixed, "mcp__demo_echo");
      assert.equal(prefixed.code, 0, prefixed.stderr);
      assert.match(prefixed.stdout, /LOCAL_MCP_RECEIPT/);
      assert.deepEqual(effects.splice(0), ["echo"]);

      fs.writeFileSync(
        configFile,
        JSON.stringify({
          ...config,
          mcpServers: { demo: { ...config.mcpServers.demo, disabled: true } },
        }),
      );
      const disabled = await invoke({ selections: ["demo"] });
      assert.ok(strings(disabled.receipt.owners).includes(extension));
      assert.ok(strings(disabled.receipt.active).includes("mcp_search"));
      assert.equal(registration(disabled, "mcp_search")?.owner, extension);
      assert.equal(registration(disabled, "mcp_search")?.namespace, undefined);
      assert.equal(registration(disabled), undefined);
      assert.equal(disabled.code, 1, `disabled whole-server: ${JSON.stringify(disabled.receipt)}`);
      assert.equal(disabled.receipt.providerCalls, 0);

      fs.writeFileSync(
        path.join(directory, "agent", "mcp.json"),
        JSON.stringify({
          mcpServers: { demo: { url: config.mcpServers.demo.url, exposure: "direct" } },
        }),
      );
      const native = await child({
        root: directory,
        tools: ["mcp__demo__echo"],
        extensions: ["builtin:mcp"],
        target: "mcp__demo__echo",
      });
      assert.equal(native.code, 0, native.stderr);
      assert.match(native.stdout, /LOCAL_MCP_RECEIPT/);
      assert.deepEqual(effects, ["echo"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
