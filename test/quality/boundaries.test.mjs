import assert from "node:assert/strict";
import { test } from "node:test";
import { relative, dirname, resolve } from "node:path";
import { mutationBoundaries, boundaryOverrides } from "../../scripts/quality-boundaries.mjs";
import { config, fixture, lint, put, remove, compiler } from "./probe-support.mjs";

function probeBoundary(boundary) {
  const dir = fixture();
  const readonlyRule = "typescript/prefer-readonly-parameter-types";
  const mutationRule = "no-param-reassign";
  try {
    const selected = boundaryOverrides(config).find((entry) => entry.files[0] === boundary.file);
    let declarations = "";
    const declarationFiles = new Map();
    const imports = [];
    const signatures = [];
    for (const [index, type] of boundary.types.entries()) {
      const name = type.name[0];
      let actual = `Actual${index}`;
      if (type.from === "file") {
        const declaration = `export interface ${name} { values: string[]; }\n`;
        if (resolve(dir, type.path) === resolve(dir, boundary.file)) {
          declarations += declaration + `type ${actual} = ${name};\n`;
        } else {
          declarationFiles.set(type.path, (declarationFiles.get(type.path) ?? "") + declaration);
          const path = relative(dirname(resolve(dir, boundary.file)), resolve(dir, type.path));
          imports.push(
            `import type { ${name} as ${actual} } from "${path.startsWith(".") ? path : `./${path}`}";`,
          );
        }
      } else if (type.from === "lib") {
        actual = `${name}<string>`;
      } else {
        imports.push(`import type { ${name} as ${actual} } from "${type.package}";`);
      }
      signatures.push(`export function approved${index}(value: ${actual}) { return value; }`);
    }
    for (const [path, text] of declarationFiles) {
      put(dir, path, text);
    }
    put(
      dir,
      boundary.file,
      `${declarations}${imports.join("\n")}\n${signatures.join("\n")}\nexport function unrelated(value: {values: string[]}) {return value;}\n`,
    );
    const changes = { overrides: [selected] };
    const compiled = compiler(dir);
    assert.equal(compiled.status, 0, compiled.stdout);
    const findings = lint(dir, [readonlyRule], [boundary.file], changes);
    assert.equal(
      findings.length,
      1,
      `${boundary.file}: approved owners plus unrelated mutable input`,
    );
    assert.equal(findings[0].rule, readonlyRule);
    if (boundary.types.length > 0) {
      put(
        dir,
        "foreign.ts",
        boundary.types
          .map(
            (type, index) =>
              `interface ${type.name[0]} { values: string[]; }\nexport function foreign${index}(value: ${type.name[0]}) {return value;}`,
          )
          .join("\n"),
      );
      assert.equal(
        lint(dir, [readonlyRule], ["foreign.ts"], changes).length,
        boundary.types.length,
      );
      const wrong = structuredClone(selected);
      wrong.rules[readonlyRule][1].allow = wrong.rules[readonlyRule][1].allow.map((type) =>
        boundary.types.some((allowed) => JSON.stringify(allowed) === JSON.stringify(type))
          ? { from: "file", path: "./foreign.ts", name: type.name }
          : type,
      );
      assert.equal(
        lint(dir, [readonlyRule], [boundary.file], { overrides: [wrong] }).length,
        boundary.types.length + 1,
        "Wrong existing origin must remove every intended owner exemption",
      );
    }
    const parameter = boundary.parameters[0] ?? "ordinary";
    put(
      dir,
      boundary.file,
      `export function permitted(${parameter}: {value:number}) { ${parameter}.value=1; }\nexport function unrelated(other: {value:number}) {other.value=1;}\n`,
    );
    const mutationChanges = {
      overrides: [{ ...selected, rules: { [mutationRule]: selected.rules[mutationRule] } }],
    };
    assert.deepEqual(
      lint(dir, [mutationRule], [boundary.file], mutationChanges).map((entry) => entry.line),
      boundary.parameters.length > 0 ? [2] : [1, 2],
    );
    put(
      dir,
      "outsider.ts",
      `export function outside(${parameter}: {value:number}) {${parameter}.value=1;}`,
    );
    assert.equal(lint(dir, [mutationRule], ["outsider.ts"], mutationChanges).length, 1);
    if (boundary.argumentPresence !== undefined) {
      const undefinedRule = "unicorn/no-useless-undefined";
      const presenceChanges = {
        overrides: [
          { files: selected.files, rules: { [undefinedRule]: selected.rules[undefinedRule] } },
        ],
      };
      put(
        dir,
        boundary.file,
        `function positional(value: unknown) { console.log(value); }\npositional(undefined);\nexport const gratuitous = () => undefined;\n`,
      );
      assert.deepEqual(
        lint(dir, [undefinedRule], [boundary.file], presenceChanges).map((entry) => entry.line),
        [3],
        "Required positional undefined passes while the unrelated arrow return stays checked",
      );
      put(
        dir,
        "outsider.ts",
        `function positional(value: unknown) { console.log(value); }\npositional(undefined);\n`,
      );
      assert.deepEqual(
        lint(dir, [undefinedRule], ["outsider.ts"], presenceChanges).map((entry) => entry.line),
        [2],
        "Argument allowance does not leak outside its owning file",
      );
    }
  } finally {
    remove(dir);
  }
}

await test("mutation-owner permissions retain origin, file and parameter isolation", async (t) => {
  await Promise.all(
    mutationBoundaries.map((boundary) => t.test(boundary.file, () => probeBoundary(boundary))),
  );
});
