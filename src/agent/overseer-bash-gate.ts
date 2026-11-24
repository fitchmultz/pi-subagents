import * as path from "node:path";
import { ShellLineScanner, tokenizeShellSegment } from "./overseer-bash-lexer.ts";

const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree"]);
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-H", "--hostname"]);
const GIT_COMMIT_LONG_VALUE_FLAGS = new Set([
  "--message",
  "--file",
  "--author",
  "--date",
  "--reuse-message",
  "--reedit-message",
  "--fixup",
  "--squash",
  "--template",
  "--cleanup",
  "--pathspec-from-file",
  "--trailer",
]);
const GIT_COMMIT_SHORT_VALUE_FLAGS = new Set(["m", "F", "c", "C", "t"]);
const GIT_COMMIT_SHORT_OPTIONAL_VALUE_FLAGS = new Set(["u", "S"]);
const GIT_PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--repo"]);
const GH_MERGE_VALUE_FLAGS = new Set([
  "-R",
  "--repo",
  "-H",
  "--hostname",
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-t",
  "--subject",
  "--match-head-commit",
  "--author-email",
]);
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
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const MAX_SHELL_NESTING = 2;

const CLI_GATED_SUBCOMMANDS = new Map<string, string>([
  ["npm", "publish"],
  ["pnpm", "publish"],
  ["yarn", "publish"],
  ["wrangler", "deploy"],
  ["chezmoi", "apply"],
]);

type CommandMatcher = (cmd: string, cmdTokens: readonly string[]) => boolean;
type CommitArgOutcome = "stop" | "bypass" | "consume_next" | "skip";

function nextSubcommand(
  tokens: readonly string[],
  start: number,
  valueFlags: ReadonlySet<string>,
): number {
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || !token.startsWith("-")) {
      return i;
    }
    i += valueFlags.has(token) ? 2 : 1;
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

function scanGitCommitShortCluster(arg: string): CommitArgOutcome {
  for (let j = 1; j < arg.length; j += 1) {
    const ch = arg[j] ?? "";
    if (ch === "n") {
      return "bypass";
    }
    if (GIT_COMMIT_SHORT_VALUE_FLAGS.has(ch)) {
      return j === arg.length - 1 ? "consume_next" : "skip";
    }
    if (GIT_COMMIT_SHORT_OPTIONAL_VALUE_FLAGS.has(ch)) {
      return "skip";
    }
  }
  return "skip";
}

function classifyGitCommitArg(arg: string): CommitArgOutcome {
  if (arg === "--") {
    return "stop";
  }
  if (arg === "--no-verify") {
    return "bypass";
  }
  if (GIT_COMMIT_LONG_VALUE_FLAGS.has(arg)) {
    return "consume_next";
  }
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length <= 1) {
    return "skip";
  }
  return scanGitCommitShortCluster(arg);
}

function hasGitCommitNoVerify(rest: readonly string[]): boolean {
  let i = 0;
  while (i < rest.length) {
    const outcome = classifyGitCommitArg(rest[i] ?? "");
    if (outcome === "stop") {
      return false;
    }
    if (outcome === "bypass") {
      return true;
    }
    i += outcome === "consume_next" ? 2 : 1;
  }
  return false;
}

function hasFlagBeforeDoubleDash(
  args: readonly string[],
  target: string,
  valueFlags: ReadonlySet<string>,
): boolean {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      return false;
    }
    if (arg === target) {
      return true;
    }
    i += valueFlags.has(arg) ? 2 : 1;
  }
  return false;
}

function isHighImpactGit(tokens: readonly string[]): boolean {
  const index = nextSubcommand(tokens, 1, GIT_VALUE_FLAGS);
  const sub = tokens[index];
  const rest = tokens.slice(index + 1);
  if (sub === "push") {
    return true;
  }
  if (sub === "commit") {
    return hasGitCommitNoVerify(rest);
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
  const subIndex = nextSubcommand(tokens, 1, GH_VALUE_FLAGS);
  const sub = tokens[subIndex];
  const action = tokens[nextSubcommand(tokens, subIndex + 1, GH_VALUE_FLAGS)];
  return (
    (sub === "pr" && action === "merge") ||
    (sub === "release" && (action === "create" || action === "delete"))
  );
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

function segmentIsShell(rawSegment: string): boolean {
  const rawCmd = unwrapCommandTokens(tokenizeShellSegment(rawSegment))[0];
  return rawCmd !== undefined && SHELL_COMMANDS.has(path.posix.basename(rawCmd));
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

function matchProtectionBypassCommand(cmd: string, cmdTokens: readonly string[]): boolean {
  if (cmd === "git") {
    const index = nextSubcommand(cmdTokens, 1, GIT_VALUE_FLAGS);
    const sub = cmdTokens[index];
    const rest = cmdTokens.slice(index + 1);
    if (sub === "commit") {
      return hasGitCommitNoVerify(rest);
    }
    if (sub === "push") {
      return hasFlagBeforeDoubleDash(rest, "--no-verify", GIT_PUSH_VALUE_FLAGS);
    }
    return false;
  }
  if (cmd === "gh" || cmd.startsWith("gh-")) {
    const subIndex = nextSubcommand(cmdTokens, 1, GH_VALUE_FLAGS);
    const actionIndex = nextSubcommand(cmdTokens, subIndex + 1, GH_VALUE_FLAGS);
    return (
      cmdTokens[subIndex] === "pr" &&
      cmdTokens[actionIndex] === "merge" &&
      hasFlagBeforeDoubleDash(cmdTokens.slice(actionIndex + 1), "--admin", GH_MERGE_VALUE_FLAGS)
    );
  }
  return false;
}

function matchSegment(rawSegment: string, depth: number, matcher: CommandMatcher): boolean {
  const trimmed = rawSegment.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return false;
  }
  const cmdTokens = unwrapCommandTokens(tokenizeShellSegment(trimmed));
  const rawCmd = cmdTokens[0];
  if (rawCmd === undefined) {
    return false;
  }
  const cmd = path.posix.basename(rawCmd);
  if (SHELL_COMMANDS.has(cmd) && depth < MAX_SHELL_NESTING) {
    const payload = extractShellDashCPayload(trimmed);
    return payload !== undefined && scanBash(payload, depth + 1, matcher);
  }
  return matcher(cmd, cmdTokens);
}

function scanBash(command: string, depth: number, matcher: CommandMatcher): boolean {
  const { segments, shellBodies } = new ShellLineScanner(segmentIsShell).scan(command);
  if (segments.some((segment) => matchSegment(segment, depth, matcher))) {
    return true;
  }
  return (
    depth < MAX_SHELL_NESTING && shellBodies.some((body) => scanBash(body, depth + 1, matcher))
  );
}

export function isHighImpactBash(command: string): boolean {
  return scanBash(command, 0, matchHighImpactCommand);
}

/**
 * Reports whether a shell command invokes a real protection-bypass flag (`gh pr merge --admin`,
 * `git commit --no-verify` / `-n`, or `git push --no-verify`), ignoring quoted commit/PR bodies
 * and operands after `--`.
 */
export function hasProtectionBypassFlag(command: string): boolean {
  return scanBash(command, 0, matchProtectionBypassCommand);
}
