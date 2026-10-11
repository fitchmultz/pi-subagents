import { jsonParser, type Token } from "stream-json/core/parser.js";
import { none } from "stream-chain/defs.js";
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
  path: (string | number)[];
  value?: Record<string, unknown> | unknown[];
  key: string;
  index: number;
}

function retained(keep: boolean | number): boolean {
  return keep === true || (typeof keep === "number" && keep !== 0 && !Number.isNaN(keep));
}

/** Validate all tokens, assembling selected values only. Skipped strings remain unpacked. */
export class JsonProjection {
  private readonly parse = jsonParser({ packValues: false });
  private readonly stack: Container[] = [];
  private scalar?: { path: (string | number)[]; text: string; limit: number; number: boolean };
  private key = false;
  private keyLimit = 4096;
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
  private parent(): Container {
    const parent = this.stack.at(-1);
    if (!parent) {
      throw new SyntaxError("JSON token requires a containing object");
    }
    return parent;
  }
  private selected(path: readonly (string | number)[]): boolean | number {
    const parent = this.stack.at(-1);
    const keep = parent && parent.value === undefined ? false : this.select(path, this.root());
    if (retained(keep) && this.limits && ++this.nodes > this.limits.nodes) {
      throw new RangeError("JSON projection exceeds its assembled-node budget.");
    }
    return keep;
  }
  private nextPath(): (string | number)[] {
    const parent = this.stack.at(-1);
    if (
      this.limits &&
      (this.stack.length > this.limits.depth || (parent && parent.index >= this.limits.arrayLength))
    ) {
      throw new RangeError("JSON projection exceeds its depth or array-position budget.");
    }
    if (!parent) {
      return [];
    }
    return [...parent.path, parent.index >= 0 ? parent.index++ : parent.key];
  }
  private put(path: readonly (string | number)[], value: unknown): void {
    const parent = this.stack.at(-1);
    if (!parent) {
      this.value = value;
      return;
    }
    const key = path.at(-1);
    if (parent.value !== undefined && key !== undefined) {
      Object.defineProperty(parent.value, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  private startContainer(array: boolean): void {
    const path = this.nextPath();
    const keep = this.selected(path);
    let value: Container["value"];
    if (retained(keep)) {
      value = array ? [] : {};
      this.put(path, value);
    }
    this.stack.push({ path, value, key: "", index: array ? 0 : -1 });
  }
  private startScalar(number: boolean): void {
    const path = this.nextPath();
    const keep = this.selected(path);
    const selectedLimit = keep === true ? Infinity : Number(keep);
    const limit = Number.isNaN(selectedLimit) ? 0 : selectedLimit;
    this.scalar = { path, text: "", limit, number };
  }
  private appendKey(text: string): void {
    const parent = this.parent();
    if (
      parent.value !== undefined &&
      this.limits &&
      parent.key.length + text.length > this.limits.keyLength
    ) {
      throw new RangeError("JSON projection exceeds its property-key budget.");
    }
    if (parent.key.length < this.keyLimit) {
      parent.key += text.slice(0, this.keyLimit - parent.key.length);
    }
  }
  private appendScalar(text: string, string: boolean): void {
    const scalar = this.scalar;
    if (!scalar) {
      return;
    }
    if (string) {
      this.stringChunk?.(scalar.path, text, this.root());
    }
    if (scalar.text.length < scalar.limit) {
      scalar.text += text.slice(0, scalar.limit - scalar.text.length);
    }
  }
  private finishScalar(): void {
    const scalar = this.scalar;
    if (scalar && scalar.limit !== 0) {
      this.put(scalar.path, scalar.number ? Number(scalar.text) : scalar.text);
    }
    this.scalar = undefined;
  }
  private token(token: Readonly<Token>): void {
    switch (token.name) {
      case "startKey": {
        const parent = this.parent();
        this.key = true;
        parent.key = "";
        this.keyLimit = parent.value === undefined ? 0 : this.keys(parent.path, this.root());
        break;
      }
      case "endKey":
        this.key = false;
        break;
      case "startObject":
        this.startContainer(false);
        break;
      case "startArray":
        this.startContainer(true);
        break;
      case "endObject":
      case "endArray":
        this.stack.pop();
        break;
      case "startString":
        this.startScalar(false);
        break;
      case "startNumber":
        this.startScalar(true);
        break;
      case "stringChunk":
      case "numberChunk":
        if (this.key) {
          this.appendKey(token.value);
        } else {
          this.appendScalar(token.value, token.name === "stringChunk");
        }
        break;
      case "endString":
      case "endNumber":
        this.finishScalar();
        break;
      case "trueValue":
      case "falseValue":
      case "nullValue": {
        const path = this.nextPath();
        const keep = this.selected(path);
        if (retained(keep)) {
          this.put(path, token.value);
        }
        break;
      }
      case "keyValue":
      case "stringValue":
      case "numberValue":
      case "whitespace":
        break; // Packing is disabled; whitespace carries no projected value.
    }
  }
  write(chunk: string | symbol): void {
    if (typeof chunk === "symbol" && chunk !== none) {
      throw new TypeError("Unknown JSON tokenizer sentinel");
    }
    const output = this.parse(typeof chunk === "symbol" ? none : chunk);
    if (typeof output !== "symbol") {
      for (const token of output.values) {
        this.token(token);
      }
    }
  }
  finish(): unknown {
    this.write(none);
    return this.value;
  }
}
