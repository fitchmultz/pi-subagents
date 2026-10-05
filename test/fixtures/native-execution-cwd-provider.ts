import { writeFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type JsonObject,
  type JsonValue,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertArray, assertRecord, parseJson } from "../support/assertions.ts";
import { isRecord, isUnknownArray } from "../../src/shared/unknown.ts";

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (isUnknownArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value);
}

export default function (pi: ExtensionAPI): void {
  const scriptText = process.env.PI_CWD_FIXTURE_SCRIPT;
  const outputPath = process.env.PI_CWD_FIXTURE_OUTPUT;
  if (scriptText === undefined || outputPath === undefined) {
    throw new Error("PI_CWD_FIXTURE_SCRIPT and PI_CWD_FIXTURE_OUTPUT are required.");
  }
  const script = parseJson(scriptText);
  assertArray(script);
  const responses = script.map((call) => {
    assertRecord(call);
    if (typeof call.name !== "string" || !isJsonObject(call.input)) {
      throw new Error("Fixture calls require a string name and JSON object input.");
    }
    return fauxAssistantMessage([fauxToolCall(call.name, call.input)], { stopReason: "toolUse" });
  });
  const faux = fauxProvider();
  faux.setResponses([...responses, fauxAssistantMessage("done")]);
  pi.registerProvider("faux", {
    api: faux.api,
    baseUrl: faux.getModel().baseUrl,
    apiKey: "fixture",
    models: faux.models,
    streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
  });
  const results: unknown[] = [];
  pi.on("tool_result", (event) => {
    results.push({ name: event.toolName, content: event.content, isError: event.isError });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    writeFileSync(
      outputPath,
      JSON.stringify({
        calls: faux.state.callCount,
        results,
        cwd: ctx.cwd,
        id: ctx.sessionManager.getSessionId(),
        file: ctx.sessionManager.getSessionFile(),
        entries: ctx.sessionManager.getEntries(),
        tools: pi.getAllTools(),
        commands: pi.getCommands(),
      }),
    );
  });
}
