import * as path from "node:path";

const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree"]);
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-H", "--hostname"]);
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

function isHighImpactGit(tokens: readonly string[]): boolean {
  const index = nextSubcommand(tokens, 1, GIT_VALUE_FLAGS);
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
  const subIndex = nextSubcommand(tokens, 1, GH_VALUE_FLAGS);
  const sub = tokens[subIndex];
  const action = tokens[nextSubcommand(tokens, subIndex + 1, GH_VALUE_FLAGS)];
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

const LINE_SEPARATORS = new Set([";", "|", "&"]);
const HEREDOC_AT_POS = /^<<(-)?[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([^\s;|&()<>'"=][^\s;|&()<>'"]*))/u;

type QuoteChar = "'" | '"' | null;

interface LineScanState {
  readonly quote: QuoteChar;
  readonly escaped: boolean;
  readonly inside: boolean;
}

interface HeredocOpener {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly end: number;
}

interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly isShellBody: boolean;
  readonly bodyLines: string[];
}

interface ShellScanResult {
  readonly segments: readonly string[];
  readonly shellBodies: readonly string[];
}

function nextQuoteState(ch: string, quote: QuoteChar): QuoteChar {
  if (ch !== "'" && ch !== '"') {
    return quote;
  }
  return quote === ch ? null : (quote ?? ch);
}

function advanceScanState(ch: string, state: LineScanState): LineScanState {
  if (state.escaped) {
    return { quote: state.quote, escaped: false, inside: true };
  }
  if (ch === "\\" && state.quote !== "'") {
    return { quote: state.quote, escaped: true, inside: true };
  }
  const updated = nextQuoteState(ch, state.quote);
  if (updated !== state.quote) {
    return { quote: updated, escaped: false, inside: true };
  }
  return { quote: state.quote, escaped: false, inside: state.quote !== null };
}

function isCommentStart(line: string, index: number): boolean {
  if (line[index] !== "#") {
    return false;
  }
  return index === 0 || /[\s;|&()]/u.test(line[index - 1] ?? "");
}

function parseHeredocOpener(line: string, index: number): HeredocOpener | undefined {
  if (!line.startsWith("<<", index) || line[index - 1] === "<" || line[index + 2] === "<") {
    return undefined;
  }
  const match = HEREDOC_AT_POS.exec(line.slice(index));
  if (match === null) {
    return undefined;
  }
  const delimiter = match[2] ?? match[3] ?? match[4];
  return delimiter === undefined
    ? undefined
    : { delimiter, stripTabs: match[1] === "-", end: index + match[0].length };
}

function segmentIsShell(rawSegment: string): boolean {
  const rawCmd = unwrapCommandTokens(tokenizeSegment(rawSegment))[0];
  return rawCmd !== undefined && SHELL_COMMANDS.has(path.posix.basename(rawCmd));
}

function isHeredocClosingLine(rawLine: string, heredoc: PendingHeredoc): boolean {
  const candidate = heredoc.stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
  return candidate === heredoc.delimiter;
}

/**
 * Linear quote-, comment-, and heredoc-aware segment scanner:
 * - carries open quotes across newlines so multi-line quoted arguments stay one segment
 * - stops at unquoted word-start `#` comments so comment apostrophes never affect later lines
 * - detects unquoted heredocs (excluding `<<<` and `$((...))`), skipping data bodies while
 *   collecting heredoc scripts fed to a shell (`bash <<'EOF'`, `sh <<'EOF'`, etc.) for scanning.
 */
class ShellLineScanner {
  private scanState: LineScanState = { quote: null, escaped: false, inside: false };
  private arithParen = 0;
  private arithBracket = 0;
  private allowHeredocs = true;
  private current = "";
  private segmentOpeners: HeredocOpener[] = [];
  private readonly segments: string[] = [];
  private readonly pendingHeredocs: PendingHeredoc[] = [];
  private readonly shellBodies: string[] = [];

  scan(command: string): ShellScanResult {
    for (const rawLine of command.split(/\r?\n/u)) {
      if (this.pendingHeredocs.length > 0) {
        this.consumeHeredocLine(rawLine);
      } else {
        this.scanLine(rawLine);
      }
    }
    this.flushSegment();
    this.drainUnterminatedHeredocs();
    return { segments: this.segments, shellBodies: this.shellBodies };
  }

  private consumeHeredocLine(rawLine: string): void {
    const active = this.pendingHeredocs[0];
    if (active === undefined) {
      return;
    }
    if (isHeredocClosingLine(rawLine, active)) {
      this.pendingHeredocs.shift();
      if (active.isShellBody && active.bodyLines.length > 0) {
        this.shellBodies.push(active.bodyLines.join("\n"));
      }
      return;
    }
    active.bodyLines.push(rawLine);
  }

  /** Fail safe: if a heredoc never closes, scan its retained lines as ordinary commands. */
  private drainUnterminatedHeredocs(): void {
    const fallbackLines: string[] = [];
    for (const heredoc of this.pendingHeredocs) {
      fallbackLines.push(...heredoc.bodyLines);
    }
    this.pendingHeredocs.length = 0;
    if (fallbackLines.length === 0) {
      return;
    }
    this.allowHeredocs = false;
    this.scanState = { quote: null, escaped: false, inside: false };
    this.arithParen = 0;
    this.arithBracket = 0;
    for (const line of fallbackLines) {
      this.scanLine(line);
    }
    this.flushSegment();
  }

  private flushSegment(): void {
    const seg = this.current;
    this.current = "";
    if (this.segmentOpeners.length > 0) {
      const isShellBody = segmentIsShell(seg);
      for (const opener of this.segmentOpeners) {
        this.pendingHeredocs.push({
          delimiter: opener.delimiter,
          stripTabs: opener.stripTabs,
          isShellBody,
          bodyLines: [],
        });
      }
      this.segmentOpeners = [];
    }
    if (seg.length > 0) {
      this.segments.push(seg);
    }
  }

  private scanLine(line: string): void {
    let i = 0;
    while (i < line.length) {
      const next = this.stepChar(line, i);
      if (next < 0) {
        return;
      }
      i = next;
    }
    const continued = this.scanState.escaped;
    this.scanState = { quote: this.scanState.quote, escaped: false, inside: false };
    if (this.scanState.quote !== null || continued) {
      this.current += "\n";
    } else {
      this.flushSegment();
    }
  }

  private stepArith(line: string, i: number): number {
    if (line.startsWith("((", i)) {
      this.arithParen += 1;
      this.current += "((";
      return i + 2;
    }
    if (this.arithParen > 0 && line.startsWith("))", i)) {
      this.arithParen -= 1;
      this.current += "))";
      return i + 2;
    }
    if (line.startsWith("$[", i)) {
      this.arithBracket += 1;
      this.current += "$[";
      return i + 2;
    }
    if (this.arithBracket > 0 && line[i] === "]") {
      this.arithBracket -= 1;
      this.current += "]";
      return i + 1;
    }
    return -1;
  }

  private canOpenHeredoc(): boolean {
    return this.allowHeredocs && this.arithParen === 0 && this.arithBracket === 0;
  }

  private stepChar(line: string, i: number): number {
    const ch = line[i] ?? "";
    this.scanState = advanceScanState(ch, this.scanState);
    if (this.scanState.inside) {
      this.current += ch;
      return i + 1;
    }
    if (isCommentStart(line, i)) {
      this.flushSegment();
      return -1;
    }
    const arithNext = this.stepArith(line, i);
    if (arithNext >= 0) {
      return arithNext;
    }
    const opener = this.canOpenHeredoc() ? parseHeredocOpener(line, i) : undefined;
    if (opener !== undefined) {
      this.segmentOpeners.push(opener);
      this.current += line.slice(i, opener.end);
      return opener.end;
    }
    if (LINE_SEPARATORS.has(ch)) {
      this.flushSegment();
      return i + 1;
    }
    this.current += ch;
    return i + 1;
  }
}

function scanHighImpactBash(command: string, depth: number): boolean {
  const { segments, shellBodies } = new ShellLineScanner().scan(command);
  if (segments.some((segment) => isHighImpactSegment(segment, depth))) {
    return true;
  }
  return (
    depth < MAX_SHELL_NESTING && shellBodies.some((body) => scanHighImpactBash(body, depth + 1))
  );
}

export function isHighImpactBash(command: string): boolean {
  return scanHighImpactBash(command, 0);
}
