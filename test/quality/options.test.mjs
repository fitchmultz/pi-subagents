import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, lint, put, remove, compiler } from "./probe-support.mjs";

await test("strict option boundaries preserve nullable presence and reject primitive coercion", () => {
  const dir = fixture();
  try {
    const cases = [
      ["typescript/strict-boolean-expressions", "any", true],
      ["typescript/strict-boolean-expressions", "number", true],
      ["typescript/strict-boolean-expressions", "string", true],
      ["typescript/strict-boolean-expressions", "boolean | undefined", true],
      ["typescript/strict-boolean-expressions", "number | undefined", true],
      ["typescript/strict-boolean-expressions", "string | undefined", true],
      ["typescript/strict-boolean-expressions", "object | undefined", false],
      ["typescript/restrict-plus-operands", "any", true],
      ["typescript/restrict-plus-operands", "boolean", true],
      ["typescript/restrict-plus-operands", "null", true],
      ["typescript/restrict-plus-operands", "RegExp", true],
      ["typescript/restrict-plus-operands", "string", true],
      ["typescript/restrict-plus-operands", "number", false],
      ["typescript/restrict-template-expressions", "any", true],
      ["typescript/restrict-template-expressions", "string[]", true],
      ["typescript/restrict-template-expressions", "null", true],
      ["typescript/restrict-template-expressions", "undefined", true],
      ["typescript/restrict-template-expressions", "RegExp", true],
      ["typescript/restrict-template-expressions", "never", true],
      ["typescript/restrict-template-expressions", "boolean", false],
      ["typescript/restrict-template-expressions", "number", false],
    ];
    for (const [rule, type, rejected] of cases) {
      let body = "if(value) {return 1;} return 0;";
      if (rule === "typescript/restrict-plus-operands") {
        body = "return value + 1;";
      }
      if (rule === "typescript/restrict-template-expressions") {
        body = "return `${value}`;";
      }
      put(dir, "main.ts", `export function check(value: ${type}) {${body}}`);
      const findings = lint(dir, [rule]);
      assert.equal(findings.length > 0, rejected, `${rule}: ${type}`);
      assert.ok(findings.every((entry) => entry.rule === rule));
    }
    put(dir, "main.ts", "export function check(value: string) {value += 1; return value;}");
    assert.equal(lint(dir, ["typescript/restrict-plus-operands"]).length, 1);
  } finally {
    remove(dir);
  }
});

await test("floating Promise strictness covers thenables, async IIFE and native Promise aliases", () => {
  const dir = fixture();
  try {
    put(
      dir,
      "main.ts",
      `export {};
void Promise.resolve();
(async () => {})();
const thenable = {then(resolve: (value: number) => void, reject: (error: Error) => void) {resolve(1);}};
thenable;
declare const native: PromiseLike<void>;
native;
await Promise.resolve();
`,
    );
    const rule = "typescript/no-floating-promises";
    assert.deepEqual(
      lint(dir, [rule]).map((entry) => [entry.rule, entry.line]),
      [
        [rule, 2],
        [rule, 3],
        [rule, 5],
        [rule, 7],
      ],
    );
  } finally {
    remove(dir);
  }
});

await test("test roles exempt size but keep branching, depth and arity", () => {
  const dir = fixture();
  try {
    const branches = (count) =>
      `export function f(value:number) {${Array.from({ length: count }, (_, index) => `if(value===${index}) {console.log(value);}`).join("\n")}}`;
    const selected = [
      "complexity",
      "max-depth",
      "max-params",
      "max-statements",
      "max-lines-per-function",
      "max-lines",
    ];
    for (const file of ["main.test.ts", "test/support/helper.ts", "test/fixtures/helper.ts"]) {
      put(dir, file, branches(14));
      assert.deepEqual(lint(dir, selected, [file]), []);
      put(dir, file, branches(15));
      assert.deepEqual(
        lint(dir, selected, [file]).map((entry) => entry.rule),
        ["complexity"],
      );
      put(
        dir,
        file,
        "export function f(a:number,b:number,c:number,d:number,e:number,f:number,g:number) {return a+b+c+d+e+f+g;}",
      );
      assert.deepEqual(
        lint(dir, selected, [file]).map((entry) => entry.rule),
        ["max-params"],
      );
      put(
        dir,
        file,
        "export function f(value:boolean) {if(value) {if(value) {if(value) {if(value) {if(value) {console.log(value);}}}}}}",
      );
      assert.ok(lint(dir, selected, [file]).some((entry) => entry.rule === "max-depth"));
      put(
        dir,
        file,
        `export function f() {\n${Array.from({ length: 501 }, () => "console.log(1);").join("\n")}\n}`,
      );
      assert.deepEqual(lint(dir, selected, [file]), []);
    }
  } finally {
    remove(dir);
  }
});

await test("intentional fixture initialization permits only its exact side-effect import", () => {
  const dir = fixture();
  try {
    put(dir, "test/support/isolated-home.ts", "export {};");
    put(dir, "test/support/unrelated.ts", "export {};");
    put(
      dir,
      "test/unit/main.test.ts",
      'import "../support/isolated-home.ts";\nimport "../support/unrelated.ts";\n',
    );
    const rule = "import/no-unassigned-import";
    assert.deepEqual(
      lint(dir, [rule], ["test/unit/main.test.ts"]).map((entry) => [entry.rule, entry.line]),
      [[rule, 2]],
    );
  } finally {
    remove(dir);
  }
});

await test("raw readonly containers permit method reassignment; readonly method contracts do not", () => {
  const dir = fixture();
  try {
    put(
      dir,
      "main.ts",
      'export function mutate(value: ReadonlyMap<string,string>): void { value.get = () => "replacement"; }',
    );
    assert.equal(compiler(dir).status, 0);
    put(
      dir,
      "main.ts",
      'export function mutate(value: Readonly<ReadonlyMap<string,string>>): void { value.get = () => "replacement"; }',
    );
    const result = compiler(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /TS2540/);
  } finally {
    remove(dir);
  }
});
