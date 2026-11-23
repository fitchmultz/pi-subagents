import * as path from "node:path";

const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree"]);
const SHELL_PREFIX_WORDS = new Set(["if", "then", "elif", "else", "do", "!"]);
const COMMAND_WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "exec",
  "time",
  "nohup",
  "xargs",
  "npx",
  "bunx",
]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh"]);
const SHELL_SEPARATORS = new Set([";", "\n", "|", "&"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const MAX_SHELL_NESTING = 2;

const CLI_GATED_SUBCOMMANDS = new Map<string, string>([
  ["npm", "publish"],
  ["pnpm", "publish"],
  ["yarn", "publish"],
  ["wrangler", "deploy"],
  ["chezmoi", "apply"],
]);

function nextGitSubcommand(tokens: readonly string[]): number {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || !token.startsWith("-")) {
      return i;
    }
    i += GIT_VALUE_FLAGS.has(token) ? 2 : 1;
  }
  return tokens.length;
}

/**
 * Linear-time subcommand matcher: accepts `target` when every preceding token is an option
 * (or a single non-flag value of the immediately preceding flag), rejecting earlier positional verbs.
 */
function hasGatedSubcommand(tokens: readonly string[], target: string): boolean {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === target) {
      return true;
    }
    if (token === undefined || !token.startsWith("-")) {
      return false;
    }
    const next = tokens[i + 1];
    const takesValue =
      !token.includes("=") && next !== undefined && !next.startsWith("-") && next !== target;
    i += takesValue ? 2 : 1;
  }
  return false;
}

function isHighImpactGit(tokens: readonly string[]): boolean {
  const index = nextGitSubcommand(tokens);
  const sub = tokens[index];
  const rest = tokens.slice(index + 1);
  if (sub === "push") {
    return true;
  }
  if (sub === "reset") {
    return rest.includes("--hard");
  }
  if (sub === "clean") {
    return rest.some(
      (arg) =>
        arg === "--force" || (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("f")),
    );
  }
  if (sub === "branch") {
    return rest.includes("-D") || (rest.includes("--delete") && rest.includes("--force"));
  }
  return false;
}

function isHighImpactGh(tokens: readonly string[]): boolean {
  const [, sub, action] = tokens;
  return (
    (sub === "pr" && action === "merge") ||
    (sub === "release" && (action === "create" || action === "delete"))
  );
}

function tokenizeSegment(rawSegment: string): string[] {
  const tokens: string[] = [];
  for (const raw of rawSegment.trim().split(/\s+/u)) {
    const cleaned = raw.replace(/^[({!]+/u, "").replace(/[)}]+$/u, "");
    if (cleaned.length > 0) {
      tokens.push(cleaned);
    }
  }
  return tokens;
}

function skipWrapperOptions(tokens: readonly string[], start: number): number {
  let i = start;
  while (i < tokens.length && (tokens[i]?.startsWith("-") ?? false)) {
    i += 1;
  }
  return i;
}

function unwrapCommandTokens(tokens: readonly string[]): readonly string[] {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i] ?? "";
    if (SHELL_PREFIX_WORDS.has(tok) || ENV_ASSIGNMENT.test(tok)) {
      i += 1;
      continue;
    }
    if (COMMAND_WRAPPERS.has(path.posix.basename(tok))) {
      i = skipWrapperOptions(tokens, i + 1);
      continue;
    }
    break;
  }
  return i === 0 ? tokens : tokens.slice(i);
}

function extractShellDashCPayload(rawSegment: string): string | undefined {
  const match = /\s-[a-zA-Z]*c\s+(?:'([^']*)'|"([^"]*)"|(\S+))/u.exec(rawSegment);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function matchHighImpactCommand(cmd: string, cmdTokens: readonly string[]): boolean {
  if (cmd === "git") {
    return isHighImpactGit(cmdTokens);
  }
  if (cmd === "gh" || cmd.startsWith("gh-")) {
    return isHighImpactGh(cmdTokens);
  }
  const gatedSub = CLI_GATED_SUBCOMMANDS.get(cmd);
  return gatedSub !== undefined && hasGatedSubcommand(cmdTokens, gatedSub);
}

function isHighImpactSegment(rawSegment: string, depth: number): boolean {
  const trimmed = rawSegment.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return false;
  }
  const cmdTokens = unwrapCommandTokens(tokenizeSegment(trimmed));
  const rawCmd = cmdTokens[0];
  if (rawCmd === undefined) {
    return false;
  }
  const cmd = path.posix.basename(rawCmd);
  if (SHELL_COMMANDS.has(cmd) && depth < MAX_SHELL_NESTING) {
    const payload = extractShellDashCPayload(trimmed);
    return payload !== undefined && scanHighImpactBash(payload, depth + 1);
  }
  return matchHighImpactCommand(cmd, cmdTokens);
}

function nextQuoteState(ch: string, quote: "'" | '"' | undefined): "'" | '"' | undefined {
  if (ch !== "'" && ch !== '"') {
    return quote;
  }
  return quote === ch ? undefined : (quote ?? ch);
}

/** Linear quote-aware segment splitter so `bash -c 'a && git push'` stays intact and `echo 'a; git push'` stays echo. */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    const updated = nextQuoteState(ch, quote);
    if (updated !== quote) {
      quote = updated;
    } else if (quote === undefined && SHELL_SEPARATORS.has(ch)) {
      segments.push(command.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
}

function scanHighImpactBash(command: string, depth: number): boolean {
  return splitShellSegments(command).some((segment) => isHighImpactSegment(segment, depth));
}

export function isHighImpactBash(command: string): boolean {
  return scanHighImpactBash(command, 0);
}
