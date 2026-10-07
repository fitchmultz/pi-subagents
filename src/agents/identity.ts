import type { AgentConfig, ChainConfig } from "../shared/types/config.ts";

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

function normalizePackageName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return trimmed
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/(?:^[-.]+|[-.]+$)/g, "");
}

export function parsePackageName(
  value: unknown,
  label = "package",
): { packageName?: string; error?: string } {
  if (value === undefined || value === false || value === "") {
    return { packageName: undefined };
  }
  if (typeof value !== "string") {
    return { error: `${label} must be a string or false when provided.` };
  }
  const packageName = normalizePackageName(value);
  if (
    packageName === undefined ||
    packageName.length === 0 ||
    !IDENTIFIER_PATTERN.test(packageName)
  ) {
    return { error: `${label} is invalid after sanitization.` };
  }
  return { packageName };
}

export function buildRuntimeName(localName: string, packageName?: string): string {
  const trimmedPackage = packageName?.trim();
  return trimmedPackage !== undefined && trimmedPackage.length > 0
    ? `${trimmedPackage}.${localName}`
    : localName;
}

export function frontmatterNameForConfig(
  config: Pick<AgentConfig | ChainConfig, "name" | "localName" | "packageName">,
): string {
  if (config.localName !== undefined && config.localName.length > 0) {
    return config.localName;
  }
  if (
    config.packageName !== undefined &&
    config.packageName.length > 0 &&
    config.name.startsWith(`${config.packageName}.`)
  ) {
    return config.name.slice(config.packageName.length + 1);
  }
  return config.name;
}
