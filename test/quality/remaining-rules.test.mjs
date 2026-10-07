import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, lint, put, remove } from "./probe-support.mjs";

await test("type-only import cycles remain prohibited", () => {
  const dir = fixture();
  try {
    put(
      dir,
      "main.ts",
      'import type {Other} from "./cycle.js";\nexport interface Main {readonly next?: Other;}\n',
    );
    put(
      dir,
      "cycle.ts",
      'import type {Main} from "./main.js";\nexport interface Other {readonly next?: Main;}\n',
    );
    assert.ok(lint(dir, ["import/no-cycle"]).some((entry) => entry.rule === "import/no-cycle"));
    put(dir, "cycle.ts", "export interface Other {readonly next?: string;}\n");
    assert.deepEqual(lint(dir, ["import/no-cycle"]), []);
  } finally {
    remove(dir);
  }
});

await test("script with-statements and blanket eslint disables remain detectable", () => {
  const dir = fixture();
  try {
    put(dir, "main.cjs", "with ({value:1}) { console.log(value); }");
    assert.equal(lint(dir, ["no-with"], ["main.cjs"])[0]?.rule, "no-with");
    put(dir, "main.ts", "// eslint-disable-next-line\nconsole.log(1);");
    assert.ok(
      lint(dir, ["unicorn/no-abusive-eslint-disable"]).some(
        (entry) => entry.rule === "unicorn/no-abusive-eslint-disable",
      ),
    );
  } finally {
    remove(dir);
  }
});

await test("meaningful undefined argument scope retains other unnecessary-undefined checks", () => {
  const dir = fixture();
  try {
    const rule = "unicorn/no-useless-undefined";
    const file = "test/unit/model-info.test.ts";
    put(dir, file, "function required(value: undefined) {return value;} required(undefined);");
    assert.deepEqual(lint(dir, [rule], [file]), []);
    put(dir, file, "export function unnecessary() {return undefined;}");
    assert.ok(lint(dir, [rule], [file]).some((entry) => entry.rule === rule));
    put(dir, "main.ts", "function unnecessary() {} unnecessary(undefined);");
    assert.ok(lint(dir, [rule]).some((entry) => entry.rule === rule));
  } finally {
    remove(dir);
  }
});
