import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import type { DelegationContract } from "./contracts.ts";

const EDIT_TOOLS = new Set(["edit", "write", "replace_text", "write_files", "apply_patch"]);
const PI_NATIVE_EDIT_TOOLS = new Set(["edit", "write"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;
// POSIX _POSIX_SYMLOOP_MAX / Linux MAXSYMLINKS upper bound for symlink traversal.
const MAX_SYMLINK_HOPS = 40;
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
      "Mutating delegation contract requires at least one verification check (or use scope: [] to disable edit tools).",
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

function normalizePiEditCandidate(cwd: string, raw: string): string | undefined {
  let normalized = raw.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (normalized === "~") {
    normalized = os.homedir();
  } else if (normalized.startsWith("~/")) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  } else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      return undefined;
    }
  }
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
}

function splitSegments(raw: string): string[] {
  return raw.replaceAll("\\", "/").split("/");
}

function readSymlinkTarget(candidate: string): string | undefined {
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() !== true) {
    return undefined;
  }
  return fs.readlinkSync(candidate);
}

function kernelCanonicalPath(initialBase: string, rawPath: string): string | undefined {
  let current = path.isAbsolute(rawPath) ? path.parse(rawPath).root : initialBase;
  const queue = splitSegments(rawPath);
  let hops = 0;
  while (queue.length > 0) {
    const segment = queue.shift();
    if (segment === undefined || segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, segment);
    const linkTarget = readSymlinkTarget(next);
    if (linkTarget !== undefined) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        return undefined;
      }
      if (path.isAbsolute(linkTarget)) {
        current = path.parse(linkTarget).root;
      }
      queue.unshift(...splitSegments(linkTarget));
      continue;
    }
    current = next;
  }
  return current;
}

function resolveTargetPath(
  cwd: string,
  resolvedCwd: string,
  candidatePath: string,
  toolName?: string,
): string | undefined {
  if (toolName !== undefined && PI_NATIVE_EDIT_TOOLS.has(toolName)) {
    const lexical = normalizePiEditCandidate(cwd, candidatePath);
    return lexical === undefined
      ? undefined
      : kernelCanonicalPath(path.parse(lexical).root, lexical);
  }
  return kernelCanonicalPath(resolvedCwd, candidatePath);
}

function canonicalScopeEntry(resolvedCwd: string, entry: string): string | undefined {
  const target = kernelCanonicalPath(resolvedCwd, entry);
  if (target === undefined) {
    return undefined;
  }
  const relative = path.relative(resolvedCwd, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

/** Checks whether `candidatePath` stays inside `cwd` and matches `scope`. */
export function isPathAllowedByScope(
  cwd: string,
  candidatePath: string,
  scope: readonly string[],
  toolName?: string,
): boolean {
  if (scope.length === 0) {
    return false;
  }
  const absCwd = path.resolve(cwd);
  const resolvedCwd = kernelCanonicalPath(path.parse(absCwd).root, absCwd);
  const resolvedTarget =
    resolvedCwd === undefined
      ? undefined
      : resolveTargetPath(cwd, resolvedCwd, candidatePath, toolName);
  if (resolvedCwd === undefined || resolvedTarget === undefined) {
    return false;
  }
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
  return scope.some((entry) => {
    const canonicalEntry = canonicalScopeEntry(resolvedCwd, entry);
    return (
      canonicalEntry !== undefined &&
      (relPosix === canonicalEntry || relPosix.startsWith(`${canonicalEntry}/`))
    );
  });
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
    return "Delegation contract (scope: []) disables file-edit tools.";
  }
  for (const target of extractTargetPaths(toolName, input)) {
    if (!isPathAllowedByScope(cwd, target, scope, toolName)) {
      return `Delegation contract scope blocks editing ${target} (allowed scope: ${scope.join(", ")}).`;
    }
  }
  return undefined;
}

/** Static system-prompt section describing the child's active delegation contract. */
export function formatContractSection(contract: DelegationContract): string {
  const scopeText =
    contract.scope.length === 0
      ? "no file edits (edit tools disabled; do not modify files via shell commands)"
      : contract.scope.join(", ");
  const lines = [
    "Follow this delegation contract strictly. Stay inside the allowed scope and stop rather than inventing workarounds outside it.",
    `- Allowed edit scope: ${scopeText}`,
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
