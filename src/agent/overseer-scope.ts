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
const PATCH_HEADERS = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];
const GLOB_META = /[*?[{]/u;
const TRAVERSAL_SEGMENT = /(?:^|[/{,])\.\.(?:$|[/},])/u;
const ABSOLUTE_SEGMENT = /(?:^|[{,])\//u;
const LEADING_DOT_PATH = /(^|\/)\./gu;
const LEADING_DOT_PATTERN = /(^|[/{,])\.(?!\.?(?:$|[/},]))/gu;

function trimList(values: readonly string[] | undefined): string[] | undefined {
  const out = values?.map((v) => v.trim()).filter(Boolean);
  return out !== undefined && out.length > 0 ? out : undefined;
}

function normalizeScopeEntry(raw: string): string {
  const s = raw.trim().replaceAll("\\", "/");
  if (s === "*") {
    return "*";
  }
  const rel = s.replace(/^(?:\.\/)+/u, "").replace(/\/+$/u, "");
  if (rel === "" || ABSOLUTE_SEGMENT.test(rel)) {
    throw new Error(
      "Contract scope entries must be relative paths or globs inside the delegation cwd (or '*' / []).",
    );
  }
  if (TRAVERSAL_SEGMENT.test(rel)) {
    throw new Error(
      "Contract scope entries must stay inside the delegation cwd without '..' traversal.",
    );
  }
  const norm = path.posix.normalize(rel);
  if (norm === "." || TRAVERSAL_SEGMENT.test(norm) || norm.startsWith("/")) {
    throw new Error(
      "Contract scope entries must stay inside the delegation cwd without '..' traversal.",
    );
  }
  return norm;
}

function normalizeScopeList(rawScope: readonly string[]): string[] {
  if (rawScope.length === 0) {
    return [];
  }
  const list = rawScope.map(normalizeScopeEntry);
  return list.includes("*") ? ["*"] : [...new Set(list)];
}

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
  const rel = path.relative(resolvedCwd, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}

function isGlobEntry(entry: string): boolean {
  return GLOB_META.test(entry);
}

function matchesGlobWithDotfiles(posix: string, pattern: string): boolean {
  if (path.posix.matchesGlob(posix, pattern)) {
    return true;
  }
  // Node's matchesGlob follows minimatch dot:false; map leading dots to SOH (\u0001) so wildcards
  // match dotfiles just like literal prefixes without turning `a*` into a match for `.a`.
  return path.posix.matchesGlob(
    posix.replace(LEADING_DOT_PATH, "$1\u0001"),
    pattern.replace(LEADING_DOT_PATTERN, "$1\u0001"),
  );
}

function existsOnDisk(candidate: string, requireDir: boolean): boolean {
  try {
    const lstat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (lstat === undefined) {
      return false;
    }
    return !requireDir || fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

/**
 * Splits an entry into a literal leading prefix and a remaining glob suffix.
 * Segments with glob metacharacters (such as `[id]` dynamic routes) stay literal when they
 * literally exist on disk inside `realCwd`, preventing accidental glob widening or broken `[id]/**`.
 */
function splitScopePrefix(
  realCwd: string,
  entry: string,
): { prefix: string | undefined; suffix: string } {
  const segments = entry.replace(/\/+$/u, "").split("/");
  let consumed = 0;
  let current = realCwd;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) {
      break;
    }
    const candidate = path.join(current, segment);
    if (isGlobEntry(segment)) {
      if (!existsOnDisk(candidate, i < segments.length - 1)) {
        break;
      }
    }
    consumed = i + 1;
    current = candidate;
  }
  if (consumed === 0) {
    return { prefix: undefined, suffix: segments.join("/") };
  }
  if (consumed === segments.length) {
    return { prefix: segments.join("/"), suffix: "" };
  }
  return {
    prefix: segments.slice(0, consumed).join("/"),
    suffix: segments.slice(consumed).join("/"),
  };
}

function validateGlobScopeEntry(
  realCwd: string,
  prefix: string | undefined,
  subject: string,
): void {
  if (prefix === undefined) {
    return;
  }
  if (fs.statSync(path.join(realCwd, prefix), { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(
      `${subject} needs an existing directory ${JSON.stringify(prefix)}; create it first if intended, or correct cwd or contract.scope.`,
    );
  }
  if (canonicalScopeEntry(realCwd, prefix) === undefined) {
    throw new Error(`${subject} does not resolve inside cwd; correct cwd or contract.scope.`);
  }
}

function validateLiteralScopeEntry(realCwd: string, entry: string, subject: string): void {
  const separator = entry.indexOf("/");
  if (separator !== -1) {
    const root = entry.slice(0, separator);
    if (fs.statSync(path.join(realCwd, root), { throwIfNoEntry: false })?.isDirectory() !== true) {
      throw new Error(
        `${subject} needs an existing directory ${JSON.stringify(root)}; create it first if intended, or correct cwd or contract.scope.`,
      );
    }
  }
  if (canonicalScopeEntry(realCwd, entry) === undefined) {
    throw new Error(`${subject} does not resolve inside cwd; correct cwd or contract.scope.`);
  }
}

function matchesScopeEntry(realCwd: string, posix: string, entry: string): boolean {
  const { prefix, suffix } = splitScopePrefix(realCwd, entry);
  if (suffix !== "") {
    if (prefix === undefined) {
      return matchesGlobWithDotfiles(posix, suffix);
    }
    const canonicalPrefix = canonicalScopeEntry(realCwd, prefix);
    if (canonicalPrefix !== undefined && posix.startsWith(`${canonicalPrefix}/`)) {
      return matchesGlobWithDotfiles(posix.slice(canonicalPrefix.length + 1), suffix);
    }
    return false;
  }
  const ce = canonicalScopeEntry(realCwd, entry);
  return ce !== undefined && (posix === ce || posix.startsWith(`${ce}/`));
}

export function validateDelegationScope(cwd: string, scope: readonly string[]): void {
  if (scope.length === 0 || scope.includes("*")) {
    return;
  }
  const realCwd = fs.realpathSync.native(cwd);
  for (const entry of scope) {
    const subject = `Delegation contract scope entry ${JSON.stringify(entry)} in cwd ${JSON.stringify(cwd)}`;
    const { prefix, suffix } = splitScopePrefix(realCwd, entry);
    if (suffix !== "") {
      validateGlobScopeEntry(realCwd, prefix, subject);
    } else {
      validateLiteralScopeEntry(realCwd, entry, subject);
    }
  }
}

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
  const realCwd = kernelCanonicalPath(path.parse(absCwd).root, absCwd);
  const realTarget =
    realCwd === undefined ? undefined : resolveTargetPath(cwd, realCwd, candidatePath, toolName);
  if (realCwd === undefined || realTarget === undefined) {
    return false;
  }
  const rel = path.relative(realCwd, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }
  if (scope.includes("*")) {
    return true;
  }
  if (rel === "") {
    return false;
  }
  const posix = rel.split(path.sep).join("/");
  return scope.some((entry) => matchesScopeEntry(realCwd, posix, entry));
}

function patchTargetPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split(/\r?\n/u)) {
    const prefix = PATCH_HEADERS.find((header) => line.startsWith(header));
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

export function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function excludedRepoPrefixes(
  topLevel: string,
  paths: readonly string[] | undefined,
): string[] {
  if (paths === undefined || paths.length === 0) {
    return [];
  }
  const top = safeRealpath(topLevel);
  return paths.flatMap((raw) => {
    const rel = path.relative(top, safeRealpath(raw));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
      ? [rel.split(path.sep).join("/")]
      : [];
  });
}

export function isExcludedRepoPath(rel: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));
}

export function shortBranchName(raw: string | undefined): string | undefined {
  return raw?.replace(/^refs\/heads\//u, "").replace(/^(?:refs\/remotes\/)?origin\//u, "");
}
