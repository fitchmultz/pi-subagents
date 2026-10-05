import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Compile } from "../../shared/native-typebox.ts";
import type { JsonSchemaObject } from "../../shared/types.ts";
import { errorText } from "./child-json.ts";

export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";

export interface StructuredOutputRuntime {
  readonly schema: JsonSchemaObject;
  readonly schemaPath: string;
  readonly outputPath: string;
}

interface CompiledJsonSchema {
  readonly Check: (value: unknown) => boolean;
  readonly Errors: (
    value: unknown,
  ) => Iterable<{ readonly instancePath?: string; readonly message?: string }>;
}

export function assertJsonSchemaObject(
  schema: unknown,
  label = "outputSchema",
): asserts schema is JsonSchemaObject {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`${label} must be a JSON Schema object.`);
  }
}

export function createStructuredOutputRuntime(
  schema: JsonSchemaObject,
  baseDir?: string,
): StructuredOutputRuntime {
  const rootDir = baseDir ?? os.tmpdir();
  fs.mkdirSync(rootDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-structured-"));
  const schemaPath = path.join(dir, "schema.json");
  const outputPath = path.join(dir, "output.json");
  fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
  return { schema, schemaPath, outputPath };
}

export function validateStructuredOutputValue(
  schema: JsonSchemaObject,
  value: unknown,
): { status: "valid" } | { status: "invalid"; message: string } {
  let validator: CompiledJsonSchema;
  try {
    validator = Compile(schema);
  } catch (error) {
    return {
      status: "invalid",
      message: `invalid outputSchema: ${errorText(error)}`,
    };
  }
  if (validator.Check(value)) {
    return { status: "valid" };
  }
  const errors = [...validator.Errors(value)].slice(0, 8).map((error) => {
    const pathText =
      error.instancePath !== undefined && error.instancePath.length > 0
        ? error.instancePath.replace(/^\//, "").replace(/\//g, ".")
        : "root";
    return `${pathText}: ${error.message ?? "schema validation failed"}`;
  });
  return {
    status: "invalid",
    message: errors.length > 0 ? errors.join("; ") : "schema validation failed",
  };
}

export function readStructuredOutput(runtime: StructuredOutputRuntime): {
  value?: unknown;
  error?: string;
} {
  if (!fs.existsSync(runtime.outputPath)) {
    return {
      error:
        "Missing structured_output call; this step has outputSchema and must finish by calling structured_output.",
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(runtime.outputPath, "utf-8"));
  } catch (error) {
    return {
      error: `Failed to read structured output: ${errorText(error)}`,
    };
  }
  const validation = validateStructuredOutputValue(runtime.schema, value);
  if (validation.status === "invalid") {
    return { error: `Structured output validation failed: ${validation.message}` };
  }
  return { value };
}
