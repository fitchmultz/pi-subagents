#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import TJS from "typescript-json-schema";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stableDefinitionNames(definitions) {
  // TJS uses TypeScript display names; NodeNext import qualifiers include the checkout path.
  // Normalize identifiers only, preserving the module suffix and every schema value.
  const prefix = `import(${JSON.stringify(`${root}/`).slice(0, -1)}`;
  const names = Object.fromEntries(
    Object.keys(definitions).map((name) => [name, name.replaceAll(prefix, 'import("')]),
  );
  if (new Set(Object.values(names)).size !== Object.keys(names).length) {
    throw new Error("Canonical schema definition names collide after path normalization.");
  }
  return names;
}

function stableSchema(schema, names, refs) {
  if (typeof schema === "boolean") {
    return schema;
  }
  const result = { ...schema };
  if (typeof schema.$ref === "string" && Object.hasOwn(refs, schema.$ref)) {
    result.$ref = refs[schema.$ref];
  }
  for (const key of ["definitions", "properties", "patternProperties", "dependencies"]) {
    if (schema[key] !== undefined) {
      result[key] = Object.fromEntries(
        Object.entries(schema[key]).map(([name, value]) => [
          key === "definitions" ? (names[name] ?? name) : name,
          Array.isArray(value) ? value : stableSchema(value, names, refs),
        ]),
      );
    }
  }
  for (const key of [
    "items",
    "additionalItems",
    "additionalProperties",
    "contains",
    "propertyNames",
    "if",
    "then",
    "else",
    "not",
    "allOf",
    "anyOf",
    "oneOf",
  ]) {
    const value = schema[key];
    if (value !== undefined) {
      result[key] = Array.isArray(value)
        ? value.map((entry) => stableSchema(entry, names, refs))
        : stableSchema(value, names, refs);
    }
  }
  return result;
}

function normalizeDefinitionPaths(schema) {
  const names = stableDefinitionNames(schema.definitions);
  const refs = Object.fromEntries(
    Object.entries(names).map(([name, stable]) => [
      `#/definitions/${encodeURIComponent(name)}`,
      `#/definitions/${encodeURIComponent(stable)}`,
    ]),
  );
  return stableSchema(schema, names, refs);
}

const mode = process.argv[2];
if (mode === "--help" || mode === "-h") {
  console.log(
    "Usage: node scripts/generate-run-schemas.mjs [--check]\nGenerate runtime JSON schemas from canonical persisted run types.\nExamples:\n  node scripts/generate-run-schemas.mjs\n  node scripts/generate-run-schemas.mjs --check",
  );
} else {
  if (mode !== undefined && mode !== "--check") {
    throw new Error(`Unknown argument: ${mode}`);
  }
  const inputs = [
    "src/shared/types/async.ts",
    "src/shared/types/owned-runs.ts",
    "src/shared/types/questions.ts",
    "src/shared/types/history.ts",
    "src/shared/types/details.ts",
    "src/runs/background/runner-config.ts",
    "src/runs/shared/native-finalization-types.ts",
  ].map((file) => path.join(root, file));
  const program = TJS.getProgramFromFiles(
    inputs,
    {
      strict: true,
      noImplicitReturns: true,
      skipLibCheck: true,
      target: "ESNext",
      lib: ["ESNext"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
    },
    root,
  );
  const generator = TJS.buildGenerator(program, {
    required: true,
    aliasRef: true,
    defaultNumberType: "number",
  });
  if (generator === null) {
    throw new Error("Canonical run types could not be compiled for schema generation.");
  }
  const names = [
    "AsyncStatus",
    "AsyncResultFile",
    "ForegroundResumeRun",
    "OwnedRun",
    "AsyncStartedEvent",
    "ControlEvent",
    "SupervisorRunContract",
    "SupervisorQuestion",
    "QuestionAnswer",
    "QuestionDelivery",
    "SupervisorQuestionView",
    "HistoryRunRow",
    "HistoryRunPage",
    "HistoryPage",
    "HistorySearchPage",
    "HistoryIndexStatus",
    "HistoryEntry",
    "HistoryResult",
    "Details",
    "SubagentExecutionResult",
    "SubagentRunConfig",
    "NativeFinalizationConfig",
    "NativeFinalizationEvent",
  ];
  const schema = normalizeDefinitionPaths(generator.getSchemaForSymbols(names));
  const target = path.join(root, "src/runs/background/schemas/RunContracts.json");
  if (mode === "--check") {
    const actual = JSON.parse(fs.readFileSync(target, "utf8"));
    if (JSON.stringify(actual) !== JSON.stringify(schema)) {
      throw new Error("Stale run schema. Run node scripts/generate-run-schemas.mjs.");
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
  }
  console.log(
    `${mode === "--check" ? "Verified" : "Generated"} ${names.length} canonical run schemas.`,
  );
}
