import { isRecord, type UnknownRecord } from "./unknown.ts";

export type Projection = (
  path: readonly (string | number)[],
  root?: UnknownRecord,
) => boolean | number;
export type KeyLimit = (parentPath: readonly (string | number)[], root?: UnknownRecord) => number;
export type StringChunk = (
  path: readonly (string | number)[],
  text: string,
  root?: UnknownRecord,
) => void;
export interface ProjectionLimits {
  readonly depth: number;
  readonly nodes: number;
  readonly arrayLength: number;
  readonly keyLength: number;
}
interface Container {
  readonly path: readonly (string | number)[];
  readonly value?: Record<string, unknown> | unknown[];
  readonly array: boolean;
  key: string;
  index: number;
}

// Grammar positions between tokens, then the two scalar states that can span chunks.
const VALUE = 0;
const FIRST_VALUE = 1;
const KEY = 2;
const FIRST_KEY = 3;
const COLON = 4;
const AFTER = 5;
const DONE = 6;
const STRING = 7;
const NUMBER = 8;
// Unescaped units exclude quote, backslash and C0 controls. Native regexp code skips a bounded
// run of them and valid escapes, so JavaScript handles only the unit that stopped it.
const BODY = /[ !#-[\]-\uffff]*(?:\\(?:["\\/bfnrt]|u[\da-fA-F]{4})[ !#-[\]-\uffff]*){0,1024}/y;
const ESCAPE = /\\(?:u([\da-fA-F]{4})|(.))/g;
const HEX = /^[\da-fA-F]{4}$/;
const ESCAPES = new Map(
  Array.from('"/\\bfnrt', (char, index) => [char.charCodeAt(0), '"/\\\b\f\n\r\t'.charAt(index)]),
);
const LITERALS = new Map<number, readonly [string, boolean | null]>([
  [102, ["false", false]],
  [110, ["null", null]],
  [116, ["true", true]],
]);
// Number states: start, sign, zero, integer, point, fraction, e, exponent sign, exponent.
// Columns: "0", "1"-"9", ".", "e"/"E", "+"/"-". A missing transition ends the number;
// only "-" reaches the start state's sign column because values dispatch on their first unit.
const NUMBER_NEXT = [
  [2, 3, -1, -1, 1],
  [2, 3],
  [-1, -1, 4, 6],
  [3, 3, 4, 6],
  [5, 5],
  [5, 5, -1, 6],
  [8, 8, -1, -1, 7],
  [8, 8],
  [8, 8],
];
const NUMBER_END = new Set([2, 3, 5, 8]);
const NUMBER_COLUMN = new Int8Array(128).fill(-1);
for (const [index, char] of Array.from("0123456789.eE+-").entries()) {
  NUMBER_COLUMN[char.charCodeAt(0)] = Number("011111111123344"[index]);
}
function unescape(_escape: string, hex: string | undefined, char: string): string {
  return hex === undefined
    ? (ESCAPES.get(char.charCodeAt(0)) ?? "")
    : String.fromCharCode(Number.parseInt(hex, 16));
}
/** Validate one escape at a backslash; false means the chunk ended inside it. */
function escapeComplete(text: string, index: number): boolean {
  if (text.charCodeAt(index) !== 92) {
    throw new SyntaxError(`Bad control character in JSON string at ${index}`);
  }
  const code = text.charCodeAt(index + 1);
  if (index + (code === 117 ? 6 : 2) > text.length) {
    return false;
  }
  if (code === 117 ? !HEX.test(text.slice(index + 2, index + 6)) : !ESCAPES.has(code)) {
    throw new SyntaxError(`Bad escaped character in JSON string at ${index}`);
  }
  return true;
}
function unexpected(index: number): SyntaxError {
  return new SyntaxError(`Unexpected character in JSON at ${index}`);
}
function retained(keep: boolean | number): boolean {
  return keep === true || (typeof keep === "number" && keep !== 0 && !Number.isNaN(keep));
}

/** Validate all JSON text, assembling selected values only. Skipped strings are never decoded. */
export class JsonProjection {
  private readonly stack: Container[] = [];
  private state = VALUE;
  private carry = "";
  private path: readonly (string | number)[] = [];
  private key = false;
  private limit = 0;
  private text = "";
  private numberState = 0;
  private keyLength?: number;
  private nodes = 0;
  private readonly select: Projection;
  private readonly stringChunk?: StringChunk;
  private readonly keys: KeyLimit;
  private readonly limits?: ProjectionLimits;
  value: unknown;
  constructor(
    select: Projection,
    stringChunk?: StringChunk,
    keys: KeyLimit = () => 4096,
    limits?: ProjectionLimits,
  ) {
    this.select = select;
    this.stringChunk = stringChunk;
    this.keys = keys;
    this.limits = limits;
  }
  private root(): UnknownRecord | undefined {
    return isRecord(this.value) ? this.value : undefined;
  }
  private shape(parent: Container | undefined): void {
    const limits = this.limits;
    if (
      limits &&
      (this.stack.length > limits.depth ||
        (parent?.array === true && parent.index >= limits.arrayLength))
    ) {
      throw new RangeError("JSON projection exceeds its depth or array-position budget.");
    }
  }
  private selected(): boolean | number {
    const keep = this.select(this.path, this.root());
    if (retained(keep) && this.limits && ++this.nodes > this.limits.nodes) {
      throw new RangeError("JSON projection exceeds its assembled-node budget.");
    }
    return keep;
  }
  /** Paths inside skipped containers are only built for string observers, never selected. */
  private start(): boolean | number {
    const parent = this.stack.at(-1);
    this.shape(parent);
    if (!parent) {
      this.path = [];
      return this.selected();
    }
    const step = parent.array ? parent.index++ : parent.key;
    if (parent.value !== undefined) {
      this.path = [...parent.path, step];
      return this.selected();
    }
    this.path = this.stringChunk ? [...parent.path, step] : parent.path;
    return false;
  }
  private put(value: unknown): void {
    const parent = this.stack.at(-1);
    const key = this.path.at(-1);
    if (!parent) {
      this.value = value;
    } else if (parent.value !== undefined && key !== undefined) {
      Object.defineProperty(parent.value, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  private ended(): void {
    this.state = this.stack.length === 0 ? DONE : AFTER;
  }
  private close(index: number): number {
    this.stack.pop();
    this.ended();
    return index + 1;
  }
  private scalar(state: number, key: boolean, limit: number): void {
    this.state = state;
    this.key = key;
    this.keyLength = undefined;
    this.limit = Number.isNaN(limit) ? 0 : limit;
    this.text = "";
  }
  private append(text: string): void {
    if (this.text.length < this.limit) {
      this.text += text.slice(0, this.limit - this.text.length);
    }
  }
  private container(array: boolean): void {
    let value: Container["value"];
    if (retained(this.start())) {
      value = array ? [] : {};
      this.put(value);
    }
    this.stack.push({ path: this.path, value, array, key: "", index: 0 });
    this.state = array ? FIRST_VALUE : FIRST_KEY;
  }
  private literal(text: string, index: number, code: number): number {
    const [word, value] = LITERALS.get(code) ?? ["", undefined];
    if (word !== "" && text.startsWith(word, index)) {
      if (retained(this.start())) {
        this.put(value);
      }
      this.ended();
      return index + word.length;
    }
    if (text.length - index < word.length && word.startsWith(text.slice(index))) {
      this.carry = text.slice(index);
      return text.length;
    }
    throw unexpected(index);
  }
  private open(state: number): void {
    const keep = this.start();
    this.scalar(state, false, keep === true ? Infinity : Number(keep));
    this.numberState = 0;
  }
  private value1(text: string, index: number, code: number): number {
    if (code === 34) {
      this.open(STRING);
      return index + 1;
    }
    if (code === 45 || (code >= 48 && code <= 57)) {
      this.open(NUMBER);
      return index;
    }
    if (code === 123 || code === 91) {
      this.container(code === 91);
      return index + 1;
    }
    return this.literal(text, index, code);
  }
  private member(index: number, code: number): number {
    const parent = this.stack.at(-1);
    if (code === 125 && this.state === FIRST_KEY) {
      return this.close(index);
    }
    if (code !== 34 || !parent) {
      throw unexpected(index);
    }
    this.scalar(STRING, true, parent.value === undefined ? 0 : this.keys(parent.path, this.root()));
    this.keyLength = parent.value === undefined ? undefined : this.limits?.keyLength;
    return index + 1;
  }
  private after(index: number, code: number): number {
    const parent = this.stack.at(-1);
    if (parent && code === 44) {
      this.state = parent.array ? VALUE : KEY;
      return index + 1;
    }
    if (parent && code === (parent.array ? 93 : 125)) {
      return this.close(index);
    }
    throw unexpected(index);
  }
  private structure(text: string, index: number, code: number): number {
    switch (this.state) {
      case VALUE:
        return this.value1(text, index, code);
      case FIRST_VALUE:
        return code === 93 ? this.close(index) : this.value1(text, index, code);
      case KEY:
      case FIRST_KEY:
        return this.member(index, code);
      case COLON:
        if (code !== 58) {
          throw unexpected(index);
        }
        this.state = VALUE;
        return index + 1;
      case AFTER:
        return this.after(index, code);
      default:
        throw unexpected(index);
    }
  }
  private observed(decoded: string): void {
    if (decoded === "") {
      return;
    }
    if (this.stringChunk && !this.key) {
      this.stringChunk(this.path, decoded, this.root());
    }
    if (this.keyLength !== undefined && this.text.length + decoded.length > this.keyLength) {
      throw new RangeError("JSON projection exceeds its property-key budget.");
    }
    this.append(decoded);
  }
  private closeString(): void {
    const parent = this.stack.at(-1);
    if (this.key && parent) {
      parent.key = this.text;
      this.state = COLON;
    } else {
      if (this.limit !== 0) {
        this.put(this.text);
      }
      this.ended();
    }
  }
  /** Observed values, unfinished selections and budgeted keys need text; others are only validated. */
  private decoding(): boolean {
    return (
      (this.stringChunk !== undefined && !this.key) ||
      this.text.length < this.limit ||
      this.keyLength !== undefined
    );
  }
  private string(text: string, start: number): number {
    for (let index = start; ;) {
      BODY.lastIndex = index;
      BODY.test(text);
      const end = BODY.lastIndex;
      if (end > index && this.decoding()) {
        const raw = text.slice(index, end);
        this.observed(raw.includes("\\") ? raw.replace(ESCAPE, unescape) : raw);
      }
      if (end === text.length) {
        return end;
      }
      if (text.charCodeAt(end) === 34) {
        this.closeString();
        return end + 1;
      }
      // Throws for controls and invalid escapes; a valid escape only ended a bounded run.
      if (!escapeComplete(text, end)) {
        this.carry = text.slice(end);
        return text.length;
      }
      index = end;
    }
  }
  private number(text: string, start: number, final: boolean): number {
    let state = this.numberState;
    let index = start;
    for (; index < text.length; index++) {
      const next = NUMBER_NEXT[state]?.[NUMBER_COLUMN[text.charCodeAt(index)] ?? -1] ?? -1;
      if (next < 0) {
        break;
      }
      state = next;
    }
    this.numberState = state;
    this.append(text.slice(start, index));
    if (index === text.length && !final) {
      return index;
    }
    if (!NUMBER_END.has(state)) {
      throw new SyntaxError(`Incomplete number in JSON at ${index}`);
    }
    if (this.limit !== 0) {
      this.put(Number(this.text));
    }
    this.ended();
    return index;
  }
  write(chunk: string): void {
    const text = this.carry + chunk;
    this.carry = "";
    let index = 0;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (this.state === STRING) {
        index = this.string(text, index);
      } else if (this.state === NUMBER) {
        index = this.number(text, index, false);
      } else if (code === 32 || code === 10 || code === 13 || code === 9) {
        index++;
      } else {
        index = this.structure(text, index, code);
      }
    }
  }
  finish(): unknown {
    if (this.state === NUMBER) {
      this.number("", 0, true);
    }
    if (this.state !== DONE || this.carry !== "") {
      throw new SyntaxError("Unexpected end of JSON input");
    }
    return this.value;
  }
}
