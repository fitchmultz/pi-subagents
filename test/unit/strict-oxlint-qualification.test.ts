import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lintProbes } from "../support/lint-probes.ts";

function branches(count: number): string {
  return `export function branches(value: number): number {
${Array.from({ length: count }, (_, n) => `  if (value === ${n}) { return ${n}; }`).join("\n")}
  return -1;
}`;
}
function depth(count: number): string {
  return `export function depth(flags: boolean[]): number {
${Array.from({ length: count }, (_, n) => `if (flags[${n}] === true) {`).join("\n")}
return 1;
${"}\n".repeat(count)}
return 0;
}`;
}
function parameters(count: number): string {
  const names = Array.from({ length: count }, (_, n) => `value${n}`);
  return `export function parameters(${names.map((name) => name + ": number").join(", ")}): number {
return ${names.join(" + ")};
}`;
}
function statements(count: number): string {
  return `export function statements(input: number): number {
${Array.from({ length: count - 1 }, (_, n) => `const value${n} = ${n === 0 ? "input" : "value" + String(n - 1)} + 1;`).join("\n")}
return value${count - 2};
}`;
}
function functionLines(count: number): string {
  return `export function lines(input: number): number[] {
return [
${"input,\n".repeat(count - 4)}];
}`;
}
function fileLines(count: number): string {
  return Array.from({ length: count }, (_, n) => `export const line${n} = ${n};`).join("\n");
}

nodeTest("native safety rules reject unsafe operations and accept owned, narrowed values", (t) => {
  const sources = {
    "valid.ts": `export function text(value: unknown): string {
  return typeof value === "string" ? value : "not a string";
}
export async function owned(): Promise<void> { await Promise.resolve(); }
export function forward(reason: unknown): Promise<never> { return Promise.reject(reason); }`,
    "unsafe.ts": "declare const unchecked: any;\nexport const unsafe: string = unchecked;",
    "assertion.ts": "export function unsafe(value: unknown): string { return value as string; }",
    "floating.ts": "export function launch(): void { Promise.resolve(); }",
    "async-callback.ts": "setTimeout(async () => { await Promise.resolve(); }, 1);",
    "rejection.ts":
      'export function reject(): Promise<never> { return Promise.reject("not an error"); }',
    "category.ts":
      "let value = 1;\nvalue = value;\nexport function read(): number { return value; }",
    "checked.mjs":
      '/** @param {unknown} value */\nexport function text(value) { return typeof value === "string" ? value : ""; }\nPromise.resolve();',
    "registration.ts":
      'import { test as nodeTest } from "node:test";\nnodeTest("not a test profile", () => { console.log("registration"); });',
    "unsafe.test.ts": "declare const unchecked: any;\nexport const unsafe: string = unchecked;",
    "category.test.ts":
      "let value = 1;\nvalue = value;\nexport function read(): number { return value; }",
  };
  const findings = lintProbes(t, sources);
  if (findings === undefined) {
    return;
  }
  assert.equal(
    findings.some((finding) => finding.file === "valid.ts"),
    false,
  );
  const expected: readonly [string, number, string][] = [
    ["unsafe.ts", 1, "no-explicit-any"],
    ["unsafe.ts", 2, "no-unsafe-assignment"],
    ["assertion.ts", 1, "no-unsafe-type-assertion"],
    ["floating.ts", 1, "no-floating-promises"],
    ["floating.ts", 1, "catch-or-return"],
    ["async-callback.ts", 1, "no-misused-promises"],
    ["rejection.ts", 1, "prefer-promise-reject-errors"],
    ["category.ts", 2, "no-self-assign"],
    ["checked.mjs", 3, "no-floating-promises"],
    ["checked.mjs", 3, "catch-or-return"],
    ["registration.ts", 2, "no-floating-promises"],
    ["unsafe.test.ts", 1, "no-explicit-any"],
    ["unsafe.test.ts", 2, "no-unsafe-assignment"],
    ["category.test.ts", 2, "no-self-assign"],
  ];
  for (const [file, line, rule] of expected) {
    assert.ok(
      findings.some(
        (finding) => finding.file === file && finding.line === line && finding.rule === rule,
      ),
      `${file}:${line} must report ${rule}`,
    );
  }
  assert.ok(
    findings.every((finding) =>
      expected.some(([file, , rule]) => finding.file === file && finding.rule === rule),
    ),
    JSON.stringify(findings),
  );
});

nodeTest("operation directives retain native findings on neighboring operations", (t) => {
  const module = `import type * as SDK from "@earendil-works/pi-coding-agent";
declare const entry: string;
// oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-004: selected native module.
export const sdk: typeof SDK = await import(entry);`;
  const mutation = `export function update(event: { cwd: string }): void {
// oxlint-disable-next-line no-param-reassign -- QX-003: caller owns this shared event.
event.cwd = "/tmp";
}`;
  const receiver = `import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line typescript/unbound-method -- QX-007: restore the actual database receiver.
const exec = DatabaseSync.prototype.exec;
export function run(db: DatabaseSync): void { exec.call(db, "CREATE TABLE actual(value TEXT)"); }`;
  const fixture = readFileSync(
    join(import.meta.dirname, "../fixtures/single-agent-provider.mjs"),
    "utf8",
  );
  const bridge = fixture.slice(
    fixture.indexOf("    /**\n     * The fork"),
    fixture.indexOf("    // Once the test asks"),
  );
  const event = `export function register(/** @type {import("@earendil-works/pi-coding-agent").ExtensionAPI} */ pi) {
${bridge}
return onParkSave;
}`;
  const cases = [
    { file: "module.ts", source: module, rule: "no-unsafe-assignment" },
    { file: "mutation.ts", source: mutation, rule: "no-param-reassign" },
    { file: "receiver.ts", source: receiver, rule: "unbound-method" },
    { file: "save-event.mjs", source: event, rule: "no-unsafe-type-assertion" },
  ];
  const sources: Record<string, string> = {};
  for (const item of cases) {
    sources["valid-" + item.file] = item.source;
    sources["invalid-" + item.file] = item.source.replace(/.*oxlint-disable-next-line[^\n]*/g, "");
  }
  const findings = lintProbes(t, sources);
  if (findings === undefined) {
    return;
  }
  assert.equal(findings.length, cases.length, JSON.stringify(findings));
  for (const item of cases) {
    assert.equal(
      findings.some((finding) => finding.file === "valid-" + item.file),
      false,
    );
    const directiveLine =
      item.source.split("\n").findIndex((line) => line.includes("oxlint-disable-next-line")) + 2;
    assert.ok(
      findings.some(
        (finding) =>
          finding.file === "invalid-" + item.file &&
          finding.rule === item.rule &&
          finding.line === directiveLine,
      ),
      JSON.stringify(findings),
    );
  }
});

nodeTest("native bootstrap allowance stays narrow and stale directives fail", (t) => {
  const findings = lintProbes(t, {
    "isolated-home.ts": "export const isolated = true;",
    "other-home.ts": "export const other = true;",
    "allowed.test.ts": 'import "./isolated-home.ts";',
    "denied.test.ts": 'import "./other-home.ts";',
    "unused.ts":
      "// oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-004: stale control.\nexport const safe = 1;",
  });
  if (findings === undefined) {
    return;
  }
  assert.equal(findings.length, 2, JSON.stringify(findings));
  assert.ok(
    findings.some(
      (finding) =>
        finding.file === "denied.test.ts" &&
        finding.line === 1 &&
        finding.rule === "no-unassigned-import",
    ),
  );
  assert.ok(
    findings.some(
      (finding) =>
        finding.file === "unused.ts" &&
        finding.line === 1 &&
        finding.message === "Unused oxlint-disable directive (no problems were reported).",
    ),
  );
});

nodeTest(
  "each native production metric enforces its boundary and tests retain their defined profile",
  (t) => {
    const metrics = [
      { rule: "complexity", generate: branches, production: 9, tests: 14 },
      { rule: "max-depth", generate: depth, production: 3, tests: 4, line: 5, testLine: 6 },
      { rule: "max-params", generate: parameters, production: 4, tests: 6 },
      { rule: "max-statements", generate: statements, production: 40 },
      { rule: "max-lines-per-function", generate: functionLines, production: 80 },
      { rule: "max-lines", generate: fileLines, production: 500, line: 501 },
    ];
    const sources: Record<string, string> = {};
    for (const metric of metrics) {
      sources[`${metric.rule}-valid.ts`] = metric.generate(metric.production);
      sources[`${metric.rule}-invalid.ts`] = metric.generate(metric.production + 1);
      sources[`${metric.rule}-valid.test.ts`] = metric.generate(
        metric.tests ?? metric.production + 100,
      );
      if (metric.tests !== undefined) {
        sources[`${metric.rule}-invalid.test.ts`] = metric.generate(metric.tests + 1);
      }
    }
    const findings = lintProbes(t, sources);
    if (findings === undefined) {
      return;
    }
    for (const metric of metrics) {
      assert.equal(
        findings.some((finding) => finding.file === `${metric.rule}-valid.ts`),
        false,
        metric.rule,
      );
      assert.equal(
        findings.some((finding) => finding.file === `${metric.rule}-valid.test.ts`),
        false,
        metric.rule,
      );
      assert.ok(
        findings.some(
          (finding) =>
            finding.file === `${metric.rule}-invalid.ts` &&
            finding.rule === metric.rule &&
            finding.line === (metric.line ?? 1),
        ),
        metric.rule,
      );
      if (metric.tests !== undefined) {
        assert.ok(
          findings.some(
            (finding) =>
              finding.file === `${metric.rule}-invalid.test.ts` &&
              finding.rule === metric.rule &&
              finding.line === (metric.testLine ?? 1),
          ),
          metric.rule,
        );
      }
    }
    assert.ok(
      findings.every(
        (finding) => finding.file.includes("-invalid.") && finding.file.startsWith(finding.rule),
      ),
      JSON.stringify(findings),
    );
  },
);
