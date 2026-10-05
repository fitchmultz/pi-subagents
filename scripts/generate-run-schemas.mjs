#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import TJS from "typescript-json-schema";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode === "--help" || mode === "-h") {
  console.log("Usage: node scripts/generate-run-schemas.mjs [--check]\nGenerate runtime JSON schemas from canonical persisted run types.\nExamples:\n  node scripts/generate-run-schemas.mjs\n  node scripts/generate-run-schemas.mjs --check");
} else {
  if (mode !== undefined && mode !== "--check") {
    throw new Error(`Unknown argument: ${mode}`);
  }
  const inputs = ["src/shared/types/async.ts", "src/shared/types/owned-runs.ts", "src/shared/types/questions.ts"].map((file) => path.join(root, file));
  const program = TJS.getProgramFromFiles(inputs, { strictNullChecks: true, skipLibCheck: true }, root);
  const generator = TJS.buildGenerator(program, { required: true, aliasRef: true, defaultNumberType: "number" });
  if (generator === null) {
    throw new Error("Canonical run types could not be compiled for schema generation.");
  }
  const names = ["AsyncStatus", "AsyncResultFile", "ForegroundResumeRun", "OwnedRun", "AsyncStartedEvent", "ControlEvent", "SupervisorRunContract", "SupervisorQuestion", "QuestionAnswer", "QuestionDelivery", "SupervisorQuestionView"];
  const schema = generator.getSchemaForSymbols(names);
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
  console.log(`${mode === "--check" ? "Verified" : "Generated"} ${names.length} canonical run schemas.`);
}
