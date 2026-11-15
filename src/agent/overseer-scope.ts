import * as path from "node:path";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import type { DelegationContract } from "./contracts.ts";

const EDIT_TOOLS = new Set(["edit", "write", "replace_text", "write_files", "apply_patch"]);
const PATCH_HEADER_PREFIXES = [
  "*** Add File: ",
  "*** Update File: ",
  "*** Delete File: ",
  "*** Move to: ",
];

function trimList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const trimmed = values.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeScopeEntry(raw: string): string {
  const trimmed = raw.trim().replaceAll("\\", "/");
  if (trimmed === "*") {
    return "*";
  }
  const stripped = trimmed.replace(/^(?:\.\/)+/u, "").replace(/\/+$/u, "");
  if (stripped.length === 0 || stripped.startsWith("/")) {
    throw new Error(
      "Contract scope entries must be relative paths inside the delegation cwd (or '*' / []).",
    );
  }
  const normalized = path.posix.normalize(stripped);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error(
      "Contract scope entries must stay inside the delegation cwd without '..' traversal.",
    );
  }
  return normalized;
}

function normalizeScopeList(rawScope: readonly string[]): string[] {
  if (rawScope.length === 0) {
    return [];
  }
  const normalized = rawScope.map(normalizeScopeEntry);
  return normalized.includes("*") ? ["*"] : [...new Set(normalized)];
}

/** Validates and normalizes a delegation contract before launch persistence. */
export function normalizeDelegationContract(raw: DelegationContract): DelegationContract {
  const scope = normalizeScopeList(raw.scope);
  const verification = trimList(raw.verification);
  if (scope.length > 0 && verification === undefined) {
    throw new Error(
      "Mutating delegation contract requires at least one verification check (or use scope: [] for read-only runs).",
    );
  }
  const baseBranch = raw.baseBranch?.trim();
  const requiredPrimitives = trimList(raw.requiredPrimitives);
  const nonGoals = trimList(raw.nonGoals);
  return {
    scope,
    ...(verification !== undefined ? { verification } : {}),
    ...(baseBranch !== undefined && baseBranch.length > 0 ? { baseBranch } : {}),
    ...(requiredPrimitives !== undefined ? { requiredPrimitives } : {}),
    ...(nonGoals !== undefined ? { nonGoals } : {}),
  };
}

/** Checks whether `candidatePath` stays inside `cwd` and matches `scope`. */
export function isPathAllowedByScope(
  cwd: string,
  candidatePath: string,
  scope: readonly string[],
): boolean {
  if (scope.length === 0) {
    return false;
  }
  const resolvedCwd = path.resolve(cwd);
  const resolvedTarget = path.resolve(resolvedCwd, candidatePath);
  const relative = path.relative(resolvedCwd, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  if (scope.includes("*")) {
    return true;
  }
  if (relative === "") {
    return false;
  }
  const relPosix = relative.split(path.sep).join("/");
  return scope.some((entry) => relPosix === entry || relPosix.startsWith(`${entry}/`));
}

function patchTargetPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split(/\r?\n/u)) {
    const prefix = PATCH_HEADER_PREFIXES.find((header) => line.startsWith(header));
    if (prefix !== undefined) {
      const target = line.slice(prefix.length).trim();
      if (target.length > 0) {
        paths.push(target);
      }
    }
  }
  return paths;
}

function batchFilePaths(files: unknown): string[] {
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.path === "string" ? [entry.path] : [],
  );
}

function extractTargetPaths(toolName: string, input: UnknownRecord): string[] {
  if ((toolName === "edit" || toolName === "write") && typeof input.path === "string") {
    return [input.path];
  }
  if (toolName === "replace_text" || toolName === "write_files") {
    return batchFilePaths(input.files);
  }
  if (toolName === "apply_patch" && typeof input.input === "string") {
    return patchTargetPaths(input.input);
  }
  return [];
}

/** Returns a block reason when a child tool call violates `contract.scope`, or `undefined`. */
export function checkToolCallScope(
  cwd: string,
  scope: readonly string[],
  toolName: string,
  input: UnknownRecord,
): string | undefined {
  if (!EDIT_TOOLS.has(toolName)) {
    return undefined;
  }
  if (scope.length === 0) {
    return "Read-only delegation contract (scope: []): file edits are disabled.";
  }
  for (const target of extractTargetPaths(toolName, input)) {
    if (!isPathAllowedByScope(cwd, target, scope)) {
      return `Delegation contract scope blocks editing ${target} (allowed scope: ${scope.join(", ")}).`;
    }
  }
  return undefined;
}

/** Static system-prompt section describing the child's active delegation contract. */
export function formatContractSection(contract: DelegationContract): string {
  const scopeText =
    contract.scope.length === 0 ? "read-only (no file edits)" : contract.scope.join(", ");
  const lines = [
    "Follow this delegation contract strictly. Stay inside the allowed scope and stop rather than inventing workarounds outside it.",
    `- Allowed scope: ${scopeText}`,
  ];
  if (contract.baseBranch !== undefined) {
    lines.push(`- Expected base branch: ${contract.baseBranch}`);
  }
  if (contract.requiredPrimitives !== undefined) {
    lines.push(
      `- Required native/package primitives (use these instead of custom wrappers): ${contract.requiredPrimitives.join("; ")}`,
    );
  }
  if (contract.nonGoals !== undefined) {
    lines.push(`- Non-goals / forbidden changes: ${contract.nonGoals.join("; ")}`);
  }
  if (contract.verification !== undefined) {
    lines.push(`- Required verification before completion: ${contract.verification.join("; ")}`);
  }
  return lines.join("\n");
}
