import assert from "node:assert/strict";
import { posix } from "node:path";
import { parseSync, Visitor, type Node, type ParseResult } from "oxc-parser";

interface Site {
  readonly file: string;
  readonly id: string;
  readonly rule: string;
  readonly selector: string;
}
interface Operation {
  readonly start: number;
  readonly selector: string;
  readonly rule: string;
}

// These are operation-bound decisions, not tolerated finding counts. Each has a
// contract comparison and native accepted/rejected controls in quality-exceptions.md.
const sites: readonly Site[] = [
  {
    file: "test/fixtures/native-execution-cwd-owner.ts",
    id: "QX-003",
    rule: "no-param-reassign",
    selector: '<anonymous>/<anonymous>/pi.on("before_agent_start")/event.systemPromptOptions.cwd',
  },
  {
    file: "test/fixtures/native-execution-cwd-owner.ts",
    id: "QX-003",
    rule: "no-param-reassign",
    selector: '<anonymous>/<anonymous>/pi.on("tool_call")/event.input.path',
  },
  {
    file: "test/fixtures/native-execution-cwd-owner.ts",
    id: "QX-003",
    rule: "no-param-reassign",
    selector:
      "<anonymous>/<anonymous>/pi.events.on(`pi-change-working-dir:${name}-execution-cwd`)/request.result",
  },
  {
    file: "src/agent/host.ts",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector: 'loadSDK/sdk = await import(pathToFileURL(path.join(root, "dist/index.js")).href)',
  },
  {
    file: "src/agent/observe-layout.ts",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector: "<module>/tuiPromise = import(root.href)",
  },
  {
    file: "src/agent/observe-layout.ts",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector: '<module>/layoutPromise = import(new URL("./layout.js", root).href)',
  },
  {
    file: "src/agent/observe-layout.ts",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector: '<module>/dispatchPromise = import(new URL("./tui.js", root).href)',
  },
  {
    file: "src/agent/typebox.ts",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/typeboxPromise = require === undefined ? import("typebox") : import(pathToFileURL(require.resolve("typebox")).href)',
  },
  {
    file: "src/agent/typebox.ts",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/valuePromise = require === undefined ? import("typebox/value") : import(pathToFileURL(require.resolve("typebox/value")).href)',
  },
  {
    file: ".github/scripts/ci-host.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/{ isolatedEnvironment, run, stageSource } = await import( pathToFileURL(join(automation, "scripts/common.mjs")).href )',
  },
  {
    file: ".github/scripts/ci-host.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/{ prepareHost, selectDevelopmentHost } = await import( pathToFileURL(join(automation, "scripts/hosts.mjs")).href )',
  },
  {
    file: "scripts/package-smoke.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      'verifyRuntime/nativeHost = await import(pathToFileURL(join(packageRoot, "dist/agent/host.js")).href)',
  },
  {
    file: "scripts/package-smoke.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      'verifyRuntime/broker = await import( pathToFileURL(join(packageRoot, "dist/pi-intercom/broker/spawn.js")).href )',
  },
  {
    file: "test/support/native-host.ts",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      'loadNativeAI/ai = await import( pathToFileURL(join(dirname(manifest), "dist/index.js")).href )',
  },
  {
    file: "test/fixtures/single-agent-shutdown.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/agentModule = await import(pathToFileURL(path.join(repo, "dist/agent/index.js")).href)',
  },
  {
    file: "test/fixtures/single-agent-parent.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/agentModule = await import(pathToFileURL(path.join(repo, "dist/agent/index.js")).href)',
  },
  {
    file: "test/fixtures/single-agent-parent.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/{ ensureActor, ownIdentity } = await import( pathToFileURL(path.join(repo, "dist/agent/process.js")).href )',
  },
  {
    file: "test/fixtures/single-agent-parent.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/{ nativePeerId } = await import( pathToFileURL(path.join(repo, "dist/pi-intercom/session-targets.js")).href )',
  },
  {
    file: "test/fixtures/single-agent-parent.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/{ enqueue, successor: createSuccessor, write, } = await import(pathToFileURL(path.join(repo, "dist/agent/storage.js")).href)',
  },
  {
    file: "test/fixtures/single-agent-parent.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      '<module>/intercomModule = ["park-wake-outcome", "park-sdk-outcome"].includes(phase) ? await import(pathToFileURL(path.join(repo, "dist/pi-intercom/index.js")).href) : undefined',
  },
  {
    file: "test/fixtures/single-agent-parent.mjs",
    id: "QX-004",
    rule: "typescript/no-unsafe-assignment",
    selector:
      'childRegistered/{ IntercomClient } = await import( pathToFileURL(path.join(repo, "dist/pi-intercom/broker/client.js")).href )',
  },
  {
    file: "test/fixtures/single-agent-provider.mjs",
    id: "QX-006",
    rule: "typescript/no-unsafe-type-assertion",
    selector: "fixture/onParkSave/pi.on.bind(pi)",
  },
  {
    file: "test/fixtures/intercom-wake-window.ts",
    id: "QX-007",
    rule: "typescript/unbound-method",
    selector: "<module>/nativeExec = DatabaseSync.prototype.exec",
  },
];

function operations(parsed: ParseResult, source: string): Operation[] {
  const found: Operation[] = [];
  const owners: string[] = [];
  const bindings: string[] = [];
  const calls: string[] = [];
  const names = new WeakMap<Node, string>();
  const text = (node: Node): string =>
    source.slice(node.start, node.end).replace(/\s+/g, " ").trim();
  const owner = (): string => (owners.length === 0 ? "<module>" : owners.join("/"));
  const enter = (node: Node): void => {
    const name =
      node.type === "FunctionDeclaration" || node.type === "FunctionExpression"
        ? node.id?.name
        : undefined;
    owners.push(names.get(node) ?? name ?? "<anonymous>");
  };
  const leave = (): void => {
    owners.pop();
  };
  const add = (node: Node, rule: string, selector: string): void => {
    found.push({ start: node.start, rule, selector: `${owner()}/${selector}` });
  };
  new Visitor({
    FunctionDeclaration: enter,
    "FunctionDeclaration:exit": leave,
    FunctionExpression: enter,
    "FunctionExpression:exit": leave,
    ArrowFunctionExpression: enter,
    "ArrowFunctionExpression:exit": leave,
    MethodDefinition(node) {
      names.set(node.value, text(node.key));
    },
    CallExpression(node) {
      const first = node.arguments[0];
      const argument =
        first !== undefined && (first.type === "Literal" || first.type === "TemplateLiteral")
          ? `(${text(first)})`
          : "";
      calls.push(text(node.callee) + argument);
      add(
        node,
        "typescript/no-unsafe-type-assertion",
        `${bindings.at(-1) ?? "<expression>"}/${text(node)}`,
      );
    },
    "CallExpression:exit"() {
      calls.pop();
    },
    VariableDeclarator(node) {
      const binding = node.id.type === "Identifier" ? node.id.name : text(node.id);
      bindings.push(binding);
      if (node.init !== null) {
        names.set(node.init, binding);
        const selector = `${binding} = ${text(node.init)}`;
        add(node, "typescript/no-unsafe-assignment", selector);
        if (node.init.type === "MemberExpression") {
          add(node, "typescript/unbound-method", selector);
        }
      }
    },
    "VariableDeclarator:exit"() {
      bindings.pop();
    },
    AssignmentExpression(node) {
      names.set(node.right, text(node.left));
      add(node, "no-param-reassign", `${calls.join("/")}/${text(node.left)}`);
    },
  }).visit(parsed.program);
  return found;
}

function checkComment(file: string, value: string): void {
  assert.ok(
    !/^(?:eslint-(?:disable|enable)|oxlint-(?:enable|disable(?!-next-line))|oxlint\s|(?:prettier|oxfmt)-ignore)\b/.test(
      value,
    ),
    `${file}: unapproved inline configuration: ${value}`,
  );
  assert.ok(!/^@ts-(?:ignore|nocheck)\b/.test(value), `${file}: compiler suppression is forbidden`);
  if (value.startsWith("@ts-expect-error")) {
    assert.match(
      file,
      /\.test-d\.[cm]?ts$/,
      "Expected compiler failures belong in negative type tests",
    );
    assert.ok(
      value.slice("@ts-expect-error".length).trim().length >= 10,
      `${file}: explain the expected type error`,
    );
  }
}

export function checkDirectives(file: string, source: string): void {
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors, [], `${file}: policy parser errors`);
  const candidates = operations(parsed, source);
  const expected = sites.filter((site) => site.file === file);
  const seen = new Set<Site>();
  for (const comment of parsed.comments) {
    const value = comment.value.trim();
    checkComment(file, value);
    if (!value.startsWith("oxlint-disable-next-line")) {
      continue;
    }
    const match = /^oxlint-disable-next-line ([\w/-]+) -- (QX-\d+): .+/.exec(value);
    assert.ok(match !== null, `${file}: use one rule, a decision ID and its contract reason`);
    const nextLine = source.indexOf("\n", comment.end) + 1;
    const lineEnd = source.indexOf("\n", nextLine);
    const attached = candidates.filter(
      (candidate) =>
        candidate.rule === match[1] &&
        candidate.start >= nextLine &&
        (lineEnd < 0 || candidate.start < lineEnd),
    );
    assert.equal(attached.length, 1, `${file}: directive must attach to exactly one operation`);
    const [operation] = attached;
    assert.ok(operation !== undefined);
    const site = expected.find(
      (candidate) =>
        candidate.id === match[2] &&
        candidate.rule === match[1] &&
        candidate.selector === operation.selector,
    );
    assert.ok(
      site !== undefined,
      `${file}: unauthorized directive operation: ${operation.selector}`,
    );
    assert.ok(!seen.has(site), `${file}: duplicated exception operation: ${site.selector}`);
    seen.add(site);
  }
  assert.equal(
    seen.size,
    expected.length,
    `${file}: stale exception operation; remove its record or restore the reviewed contract`,
  );
  checkImports(file, parsed);
  if (file === "test/fixtures/intercom-wake-window.ts") {
    checkNativeReceiver(parsed, source);
  }
}

function checkImports(file: string, parsed: ParseResult): void {
  for (const imported of parsed.module.staticImports) {
    const request = imported.moduleRequest.value;
    if (imported.entries.length === 0 && request.endsWith("/isolated-home.ts")) {
      assert.equal(
        posix.normalize(posix.join(posix.dirname(file), request)),
        "test/support/isolated-home.ts",
        `${file}: QX-005 applies only to the actual isolation owner`,
      );
    }
  }
}

function checkNativeReceiver(parsed: ParseResult, source: string): void {
  const references: number[] = [];
  const permitted: number[] = [];
  let receiverBody: Node | undefined;
  new Visitor({
    AssignmentExpression(node) {
      if (source.slice(node.left.start, node.left.end) === "DatabaseSync.prototype.exec") {
        assert.equal(receiverBody, undefined, "Only one native exec replacement is authorized");
        assert.equal(
          node.right.type,
          "FunctionExpression",
          "Native exec must retain its dynamic receiver",
        );
        receiverBody = node.right;
      }
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.id.name === "nativeExec") {
        permitted.push(node.id.start);
      }
    },
    Identifier(node) {
      if (node.name === "nativeExec") {
        references.push(node.start);
      }
    },
    CallExpression(node) {
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "nativeExec"
      ) {
        assert.equal(
          source.slice(node.start, node.end).replace(/\s+/g, ""),
          "nativeExec.call(this,sql)",
          "Forward native exec with its actual database receiver",
        );
        assert.ok(
          receiverBody !== undefined &&
            node.start > receiverBody.start &&
            node.end < receiverBody.end,
          "Native exec belongs inside its receiver replacement",
        );
        permitted.push(node.callee.object.start);
      }
    },
  }).visit(parsed.program);
  assert.equal(permitted.length, 2, "Native exec is captured and invoked once");
  assert.deepEqual(references, permitted, "Native exec cannot escape or acquire an unbound caller");
}
