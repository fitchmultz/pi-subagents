import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_FANOUT_CHILD_ENV } from "./child-route-env.ts";
import { setPromptSection } from "../../shared/prompt-sections.ts";
import { loadConfig } from "../../extension/config.ts";
import { registerChildExecutionCwd } from "./child-execution-cwd.ts";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
  assertJsonSchemaObject,
} from "./structured-output.ts";
import { registerChildStructuredTool } from "./child-structured-tool.ts";
import { ChildNativeObservation } from "./child-native-observation.ts";
import { stripParentOnlySubagentMessages } from "./child-context-filter.ts";
import { nonempty } from "./child-json.ts";

const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
  "This subagent step has a strict structured output contract.",
  "Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
  "Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
  "You are a child subagent, not the parent orchestrator.",
  "The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
  "Ignore prior parent-only orchestration instructions in inherited conversation history.",
  "Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
  "If you need to edit files, call the actual edit/write tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
  "You are a child subagent with delegation enabled for your assigned task.",
  "You may delegate useful helper work within that task when it saves time or improves quality, using the available delegation tools.",
  "You remain responsible for your assigned result. The original parent owns integration, review synthesis, and final delivery.",
  "Do not broaden the assigned scope or repeat approval requests for already-authorized work.",
  "The native allowSubagents and maxSubagentDepth settings still apply.",
  "If you need to edit files, call the actual edit/write tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

function readBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : value !== "0";
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
  registerChildExecutionCwd(pi);
  const observation = new ChildNativeObservation();
  pi.on("session_start", (_event, ctx) => observation.start(ctx));
  pi.on("message_end", (event) => observation.message(event.message.role));
  pi.on("turn_end", (_event, ctx) => observation.publish(ctx, "turn", pi));
  pi.on("agent_settled", (_event, ctx) => observation.publish(ctx, "settled", pi));
  const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
  const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
  if (nonempty(structuredOutputPath) && nonempty(structuredSchemaPath)) {
    const schema: unknown = JSON.parse(fs.readFileSync(structuredSchemaPath, "utf-8"));
    assertJsonSchemaObject(schema);
    registerChildStructuredTool(pi, {
      schema,
      schemaPath: structuredSchemaPath,
      outputPath: structuredOutputPath,
    });
    pi.on("session_start", () => {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), "structured_output"])]);
    });
  }

  pi.on("context", (event) => {
    // Filtering changes the provider prefix, never the saved journal. Fanout children
    // need their own nested calls/results on later turns and resumes, so retain tool history.
    const messages = stripParentOnlySubagentMessages(
      event.messages,
      readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV) === true,
    );
    if (messages === undefined) {
      return;
    }
    return { messages };
  });

  pi.on("before_agent_start", (event) => {
    const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
    if (nonempty(intercomSessionName)) {
      pi.setSessionName(intercomSessionName);
    }

    const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
    const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
    const fanoutChild = readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV);
    if (
      inheritProjectContext === undefined &&
      inheritSkills === undefined &&
      fanoutChild === undefined
    ) {
      return;
    }
    const options = event.systemPromptOptions;
    // --no-skills/--no-context-files govern discovery. Keep explicitly selected
    // skill bodies and context intact; never parse the rendered prompt to remove resources.
    options.skills = options.skills.filter((skill) => skill.name !== "pi-subagents");
    setPromptSection(
      options,
      "subagent_role",
      fanoutChild === true
        ? `${CHILD_FANOUT_BOUNDARY_INSTRUCTIONS}\n${
            loadConfig().compactChildTools === false
              ? "Use subagent({action:'list'}) to discover agents before delegation."
              : "Use load_subagent({advanced:false}), then agent_runs({action:'profiles'}) to discover agents, delegate for ordinary work, and load_subagent for advanced workflows."
          }`
        : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
    );
    if (nonempty(structuredOutputPath)) {
      setPromptSection(options, "subagent_output", STRUCTURED_OUTPUT_INSTRUCTIONS);
    }
  });
}
