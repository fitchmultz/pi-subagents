import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript-api";
import { resolve } from "node:path";
import { config, fixture, lint, put, remove, compiler } from "./probe-support.mjs";

await test("native registration allowance isolates declarations, aliases and subtests", () => {
  const dir = fixture();
  try {
    put(dir, "foreign.ts", "export function test(): Promise<void> { return Promise.resolve(); }");
    put(dir, "reexport.ts", 'export { test as register, describe as group } from "node:test";');
    put(
      dir,
      "node_modules/quality-foreign/package.json",
      '{"name":"quality-foreign","types":"index.d.ts"}',
    );
    put(
      dir,
      "node_modules/quality-foreign/index.d.ts",
      "export declare function test(): Promise<void>;",
    );
    put(
      dir,
      "main.ts",
      `import native, { test, describe, it, test as alias } from "node:test";
import * as namespace from "node:test";
import { register, group } from "./reexport.js";
import { test as foreign } from "./foreign.js";
import { test as packaged } from "quality-foreign";
test("one", () => {});
describe("suite", () => {});
it("two", () => {});
alias("three", () => {});
native("four", () => {});
namespace.test("five", () => {});
(test)("six", () => {});
register("seven", () => {});
group("group", () => {});
{ function test(): Promise<void> { return Promise.resolve(); } test(); }
foreign();
packaged();
function ordinary(): Promise<void> { return Promise.resolve(); }
ordinary();
test("parent", (t) => { t.test("subtest", () => {}); });
const copied: typeof test = test;
copied("copied", () => {});
`,
    );
    const rule = "typescript/no-floating-promises";
    const allowance = {
      from: "file",
      path: "./node_modules/@types/node/test.d.ts",
      name: ["test", "suite"],
    };
    assert.deepEqual(
      config.rules[rule][1].allowForKnownSafeCalls,
      [allowance],
      "Effective safe-call policy must select the native declaration only",
    );
    const options = { ...config.rules[rule][1] };
    const diagnostics = lint(dir, [rule], ["main.ts"], { rules: { [rule]: ["error", options] } });
    assert.deepEqual(
      diagnostics.map((entry) => [entry.rule, entry.line]),
      [
        [rule, 15],
        [rule, 16],
        [rule, 17],
        [rule, 19],
        [rule, 20],
        [rule, 22],
      ],
    );
    assert.equal(compiler(dir).status, 0, compiler(dir).stdout);
    options.allowForKnownSafeCalls = [{ ...allowance, path: "./foreign.ts" }];
    const wrongPath = lint(dir, [rule], ["main.ts"], { rules: { [rule]: ["error", options] } });
    assert.ok(
      wrongPath.some((entry) => entry.line === 6),
      "Wrong existing file must remove native exemption",
    );
    assert.ok(
      !wrongPath.some((entry) => entry.line === 16),
      "Only selected foreign declaration is allowed",
    );
  } finally {
    remove(dir);
  }
});

await test("readonly SDK/native allowances isolate real declarations from mutable names", () => {
  const dir = fixture();
  try {
    const groups = [
      [
        "@earendil-works/pi-coding-agent",
        [
          "ExtensionAPI",
          "ExtensionContext",
          "Theme",
          "SessionManager",
          "AgentSession",
          "ExtensionUIContext",
          "ExtensionToolContext",
          "BeforeAgentStartEvent",
          "AgentBeforeSettleEvent",
          "SessionMessageEntry",
          "EventBus",
          "EventBusController",
          "DefaultPackageManager",
          "SettingsManager",
          "SessionEntry",
          "ModelRegistry",
          "ScopedModel",
        ],
      ],
      ["@earendil-works/pi-agent-core", ["AgentMessage"]],
      [
        "@earendil-works/pi-tui",
        [
          "TUI",
          "KeybindingsManager",
          "Component",
          "Editor",
          "ScrollView",
          "Container",
          "SelectList",
          "Input",
        ],
      ],
      [
        "@earendil-works/pi-ai",
        [
          "Message",
          "Model",
          "AssistantMessage",
          "Usage",
          "TextContent",
          "ThinkingContent",
          "ImageContent",
          "ToolCall",
          "SystemMessage",
          "UserMessage",
        ],
      ],
      ["node:net", ["Socket"]],
      ["node:buffer", ["Buffer"]],
      ["node:child_process", ["ChildProcess", "ChildProcessByStdio", "SpawnOptions"]],
      ["node:fs", ["FSWatcher", "Stats"]],
      ["node:string_decoder", ["StringDecoder"]],
      ["node:stream", ["Readable"]],
      ["node:crypto", ["Hash"]],
      ["node:sqlite", ["DatabaseSync", "StatementSync"]],
      ["node:fs", ["BigIntStats"]],
      ["node:test", ["TestContext"]],
    ];
    const webNames = [
      "Request",
      "RequestInit",
      "Response",
      "ResponseInit",
      "Headers",
      "AbortController",
      "Blob",
      "File",
      "FormData",
      "ReadableStream",
      "ReadableStreamDefaultReader",
      "ReadableStreamBYOBReader",
      "ReadableStreamDefaultController",
      "ReadableByteStreamController",
      "ReadableStreamBYOBRequest",
      "WritableStream",
      "WritableStreamDefaultWriter",
      "WritableStreamDefaultController",
      "TransformStream",
      "TransformStreamDefaultController",
    ];
    const names = [...groups.flatMap(([, members]) => members), ...webNames];
    const isolatedNames = [
      "AgentBeforeSettleEvent",
      "SessionMessageEntry",
      "UsageEntry",
      "AgentMessage",
      "EventBus",
    ];
    const foreignDeclarations = isolatedNames
      .map((name) => `export interface ${name} { values: string[]; }`)
      .join("\n");
    put(dir, "foreign-sdk.ts", foreignDeclarations);
    put(
      dir,
      "node_modules/quality-foreign-sdk/package.json",
      '{"name":"quality-foreign-sdk","types":"index.d.ts"}',
    );
    put(dir, "node_modules/quality-foreign-sdk/index.d.ts", foreignDeclarations);
    const imports = groups.map(
      ([pkg, members]) => `import type {${members.join(",")}} from "${pkg}";`,
    );
    imports.push(
      'import type {KeybindingsManager as CodingKeybindingsManager} from "@earendil-works/pi-coding-agent";',
    );
    for (const [source, prefix] of [
      ["./foreign-sdk.js", "Foreign"],
      ["quality-foreign-sdk", "Packaged"],
    ]) {
      imports.push(
        `import type {${isolatedNames.map((name) => `${name} as ${prefix}${name}`).join(",")}} from "${source}";`,
      );
    }
    const parameterTypes = {
      Model: "Model<'anthropic-messages'>",
      ChildProcessByStdio: "ChildProcessByStdio<null, Readable, Readable>",
    };
    const positives = [
      ...names,
      "CodingKeybindingsManager",
      "NodeJS.Timeout",
      "Promise<void>",
      "PromiseLike<void>",
      "Generator<void, number>",
      "ExtensionContext['sessionManager']",
      "Extract<SessionEntry, {type: 'usage'}>",
      "Readonly<Partial<ExtensionContext>>",
      "URL",
      "URLSearchParams",
      "AbortSignal",
    ].map(
      (name, index) =>
        `export function positive${index}(value: ${parameterTypes[name] ?? name}) { return value; }`,
    );
    const negatives = [
      ...names,
      "Timeout",
      "URL",
      "URLSearchParams",
      "AbortSignal",
      "Promise",
      "PromiseLike",
      "Generator",
      "ReadonlySessionManager",
      "UsageEntry",
    ].map(
      (name) =>
        `{ interface ${name} { values: string[]; } function negative(value: ${name}) { return value; } }`,
    );
    for (const prefix of ["Foreign", "Packaged"]) {
      negatives.push(
        ...isolatedNames.map(
          (name) =>
            `export function negative${prefix}${name}(value: ${prefix}${name}) { return value; }`,
        ),
      );
    }
    put(
      dir,
      "main.ts",
      [
        ...imports,
        ...positives,
        ...negatives,
        "export function mutable(value: Map<string, string>) { return value; }",
        "export function nested(value: ReadonlyMap<string, { values: string[] }>) { return value; }",
        "export function application(value: { labels: string[]; native: URL }) { return value; }",
        "export function rawReadonly(value: ReadonlyMap<string, string>) { return value; }",
        "export function frozenMutableMap(value: Readonly<Map<string, string>>) { return value; }",
        "export function frozenMutableSet(value: Readonly<Set<string>>) { return value; }",
        "export function nestedReadonlyMap(value: Readonly<ReadonlyMap<string, { values: string[] }>>) { return value; }",
        "export function nestedReadonlySet(value: Readonly<ReadonlySet<{ values: string[] }>>) { return value; }",
        "export function readonly(value: Readonly<ReadonlyMap<string, string>>) { return value; }",
        "export function readonlySet(value: Readonly<ReadonlySet<string>>) { return value; }",
        "export function deepMap(value: Readonly<ReadonlyMap<string, { readonly values: readonly string[] }>>) { return value; }",
        "export function deepSet(value: Readonly<ReadonlySet<{ readonly values: readonly string[] }>>) { return value; }",
      ].join("\n"),
    );
    const rule = "typescript/prefer-readonly-parameter-types";
    const compiled = compiler(dir);
    assert.equal(compiled.status, 0, compiled.stdout);
    const actual = lint(dir, [rule]);
    const first = imports.length + positives.length + 1;
    assert.deepEqual(
      actual.map((entry) => entry.line),
      Array.from({ length: negatives.length + 8 }, (_, index) => first + index),
    );
    // Raw ReadonlyMap methods themselves are assignable, unlike the Readonly-wrapped contract.
    // Keep both unsuppressed cases; never blanket-allow generic containers.
    const project = ts.createProgram([resolve(dir, "main.ts")], {
      strict: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ESNext,
      skipLibCheck: true,
    });
    const source = project.getSourceFile(resolve(dir, "main.ts"));
    const checker = project.getTypeChecker();
    for (const statement of source.statements.filter(ts.isImportDeclaration)) {
      if (
        statement.moduleSpecifier.text === "./foreign-sdk.js" ||
        statement.moduleSpecifier.text === "quality-foreign-sdk"
      ) {
        continue;
      }
      for (const binding of statement.importClause.namedBindings.elements) {
        const symbol = checker.getAliasedSymbol(checker.getSymbolAtLocation(binding.name));
        assert.ok(
          symbol.declarations?.some((declaration) =>
            declaration.getSourceFile().fileName.includes("node_modules/"),
          ),
          binding.name.text,
        );
      }
    }
  } finally {
    remove(dir);
  }
});
