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

export interface ShellScanResult {
  readonly segments: readonly string[];
  readonly shellBodies: readonly string[];
}

interface TokenDraft {
  value: string;
  hasQuoted: boolean;
  startsQuoted: boolean;
  endsQuoted: boolean;
}

function createDraft(): TokenDraft {
  return { value: "", hasQuoted: false, startsQuoted: false, endsQuoted: false };
}

function flushTokenDraft(tokens: string[], draft: TokenDraft): void {
  if (draft.value.length === 0 && !draft.hasQuoted) {
    return;
  }
  let cleaned = draft.value;
  if (!draft.startsQuoted) {
    cleaned = cleaned.replace(/^[({!]+/u, "");
  }
  if (!draft.endsQuoted) {
    cleaned = cleaned.replace(/[)}]+$/u, "");
  }
  if (cleaned.length > 0 || draft.hasQuoted) {
    tokens.push(cleaned);
  }
}

class SegmentTokenizer {
  private readonly tokens: string[] = [];
  private quote: QuoteChar = null;
  private escaped = false;
  private current: TokenDraft = createDraft();

  tokenize(rawSegment: string): string[] {
    for (const ch of rawSegment) {
      this.step(ch);
    }
    flushTokenDraft(this.tokens, this.current);
    return this.tokens;
  }

  private step(ch: string): void {
    if (this.escaped) {
      this.appendUnquoted(ch);
      this.escaped = false;
      return;
    }
    if (ch === "\\" && this.quote !== "'") {
      this.escaped = true;
      return;
    }
    if (this.quote !== null) {
      this.stepQuoted(ch);
      return;
    }
    if (ch === "'" || ch === '"') {
      this.openQuote(ch);
      return;
    }
    if (/\s/u.test(ch)) {
      flushTokenDraft(this.tokens, this.current);
      this.current = createDraft();
      return;
    }
    this.appendUnquoted(ch);
  }

  private stepQuoted(ch: string): void {
    if (ch === this.quote) {
      this.quote = null;
      this.current.endsQuoted = true;
    } else {
      this.current.value += ch;
    }
  }

  private openQuote(ch: "'" | '"'): void {
    if (this.current.value.length === 0 && !this.current.hasQuoted) {
      this.current.startsQuoted = true;
    }
    this.quote = ch;
    this.current.hasQuoted = true;
  }

  private appendUnquoted(ch: string): void {
    this.current.value += ch;
    this.current.endsQuoted = false;
  }
}

/** Quote- and escape-aware shell segment tokenizer preserving empty quoted arguments. */
export function tokenizeShellSegment(rawSegment: string): string[] {
  return new SegmentTokenizer().tokenize(rawSegment);
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
export class ShellLineScanner {
  private readonly isShellSegment: (rawSegment: string) => boolean;
  private scanState: LineScanState = { quote: null, escaped: false, inside: false };
  private arithParen = 0;
  private arithBracket = 0;
  private allowHeredocs = true;
  private current = "";
  private segmentOpeners: HeredocOpener[] = [];
  private readonly segments: string[] = [];
  private readonly pendingHeredocs: PendingHeredoc[] = [];
  private readonly shellBodies: string[] = [];

  constructor(isShellSegment: (rawSegment: string) => boolean) {
    this.isShellSegment = isShellSegment;
  }

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
      const isShellBody = this.isShellSegment(seg);
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
