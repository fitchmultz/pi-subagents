import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "../../shared/native-typebox.ts";
import {
  validateStructuredOutputValue,
  type StructuredOutputRuntime,
} from "./structured-output.ts";

/** Native tool registration owns schema validation, capture publication and termination. */
export function registerChildStructuredTool(
  pi: ExtensionAPI,
  runtime: StructuredOutputRuntime,
): void {
  pi.registerTool({
    name: "structured_output",
    label: "Structured Output",
    description: "Submit the complete output matching the current schema.",
    parameters: Type.Object(
      { value: Type.Unsafe(runtime.schema) },
      { additionalProperties: false },
    ),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    execute: async (_id, args) => {
      const validation = validateStructuredOutputValue(runtime.schema, args.value);
      if (validation.status === "invalid") {
        throw new Error(validation.message);
      }
      fs.mkdirSync(path.dirname(runtime.outputPath), { recursive: true });
      fs.writeFileSync(runtime.outputPath, JSON.stringify(args.value), { mode: 0o600 });
      return {
        content: [{ type: "text", text: "Structured output captured." }],
        details: { path: runtime.outputPath },
        terminate: true,
      };
    },
  });
}
