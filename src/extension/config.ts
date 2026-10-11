import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig } from "../shared/types.ts";
import { getAgentDir } from "../shared/agent-dir.ts";
import { isRecord } from "../shared/unknown.ts";
import { extensionConfig } from "./config-schema.ts";

function normalizedTrust(
  config: Readonly<Record<string, unknown>>,
  configPath: string,
): Readonly<Record<string, unknown>> {
  const trust = config.projectTrust;
  const childRuns = isRecord(trust) ? trust.childRuns : trust;
  if (
    childRuns !== undefined &&
    childRuns !== "inherit" &&
    childRuns !== "approve" &&
    childRuns !== "no-approve"
  ) {
    console.error(`Invalid projectTrust in '${configPath}'; child runs will use no-approve.`);
    return { ...config, projectTrust: "no-approve" };
  }
  return config;
}

export function loadConfig(): ExtensionConfig {
  const configPath = path.join(getAgentDir(), "extensions", "subagent", "config.json");
  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!isRecord(parsed)) {
      throw new Error("Subagent configuration must be an object.");
    }
    const config = normalizedTrust(parsed, configPath);
    if (!extensionConfig.Check(config)) {
      throw new Error([...extensionConfig.Errors(config)].map((error) => error.message).join("; "));
    }
    return config;
  } catch (error) {
    console.error(`Failed to load subagent config from '${configPath}':`, error);
    return {};
  }
}
