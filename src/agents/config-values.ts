import * as fs from "node:fs";

export type ConfigObject = Readonly<Record<string, unknown>>;

export function isConfigObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error === null) {
    return "null";
  }
  if (error === undefined) {
    return "undefined";
  }
  if (typeof error === "object") {
    return Object.prototype.toString.call(error);
  }
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "number" ||
    typeof error === "bigint" ||
    typeof error === "boolean" ||
    typeof error === "symbol"
  ) {
    return String(error);
  }
  return Object.prototype.toString.call(error);
}

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
