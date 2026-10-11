import * as fs from "node:fs";

import { errorMessage, isRecord as isConfigObject, type UnknownRecord } from "../shared/unknown.ts";
export { errorMessage, isRecord as isConfigObject } from "../shared/unknown.ts";
export type ConfigObject = UnknownRecord;

export function readSettingsFileStrict(filePath: string): ConfigObject {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read settings file '${filePath}': ${errorMessage(error)}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse settings file '${filePath}': ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isConfigObject(parsed)) {
    throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
  }
  return parsed;
}

export function csvItems(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function splitToolList(rawTools: readonly string[] | undefined): {
  tools?: string[];
  mcpDirectTools?: string[];
} {
  const mcpDirectTools: string[] = [];
  const tools: string[] = [];
  for (const tool of rawTools ?? []) {
    if (tool.startsWith("mcp:")) {
      mcpDirectTools.push(tool.slice(4));
    } else {
      tools.push(tool);
    }
  }
  return {
    ...(tools.length > 0 ? { tools } : {}),
    ...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
  };
}
