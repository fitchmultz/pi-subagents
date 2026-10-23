import { types } from "node:util";

/** Live previews of arbitrary native values; durable journal records remain authoritative. */
export type Unavailable = "oversize" | "cyclic" | "unreadable" | "unsupported";
export type Bounded = { readonly json: string } | { readonly unavailable: Unavailable };
export interface JsonBudget {
  readonly bytes: number;
  readonly nodes: number;
  readonly depth: number;
}
class Limit extends Error {
  readonly reason: Unavailable;
  constructor(reason: Unavailable) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Proxies, accessors and custom serializers would run arbitrary code inside the actor; binary
 * values allocate their full representation. None of them is read.
 */
function opaque(value: object): boolean {
  return (
    types.isProxy(value) ||
    ArrayBuffer.isView(value) ||
    types.isAnyArrayBuffer(value) ||
    "toJSON" in value
  );
}
/** An own data property's value, without invoking a getter. */
function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor !== undefined && !("value" in descriptor)) {
    throw new Limit("unsupported");
  }
  return descriptor?.value;
}

/** Serialize like JSON.stringify within byte, node and depth limits, without first cloning. */
class Writer {
  private readonly parts: string[] = [];
  private bytes = 0;
  private nodes = 0;
  private readonly ancestors = new Set<object>();
  private readonly budget: JsonBudget;
  constructor(budget: JsonBudget) {
    this.budget = budget;
  }
  text(): string {
    return this.parts.join("");
  }
  private add(text: string, bytes = text.length): void {
    this.bytes += bytes;
    if (this.bytes > this.budget.bytes) {
      throw new Limit("oversize");
    }
    this.parts.push(text);
  }
  private string(value: string): void {
    // A string never encodes to fewer bytes than code units; refuse before copying it.
    if (value.length > this.budget.bytes - this.bytes) {
      throw new Limit("oversize");
    }
    const json = JSON.stringify(value);
    this.add(json, Buffer.byteLength(json));
  }
  /** Returns false for values JSON omits from objects and nulls in arrays. */
  value(value: unknown, depth: number): boolean {
    if (++this.nodes > this.budget.nodes) {
      throw new Limit("oversize");
    }
    switch (typeof value) {
      case "string":
        this.string(value);
        return true;
      case "number":
        this.add(Number.isFinite(value) ? String(value) : "null");
        return true;
      case "boolean":
        this.add(String(value));
        return true;
      case "bigint":
        throw new Limit("unsupported");
      case "object":
        this.object(value, depth);
        return true;
      case "undefined":
      case "function":
      case "symbol":
        return false;
    }
  }
  private object(value: object | null, depth: number): void {
    if (value === null) {
      this.add("null");
      return;
    }
    if (depth >= this.budget.depth) {
      throw new Limit("oversize");
    }
    if (this.ancestors.has(value)) {
      throw new Limit("cyclic");
    }
    if (types.isDate(value) && !types.isProxy(value)) {
      const time = Date.prototype.getTime.call(value);
      this.add(Number.isNaN(time) ? "null" : JSON.stringify(new Date(time).toISOString()));
      return;
    }
    if (opaque(value)) {
      throw new Limit("unsupported");
    }
    this.ancestors.add(value);
    if (Array.isArray(value)) {
      this.array(value, depth + 1);
    } else {
      this.record(value, depth + 1);
    }
    this.ancestors.delete(value);
  }
  private array(value: readonly unknown[], depth: number): void {
    this.add("[");
    for (let index = 0; index < value.length; index++) {
      if (index > 0) {
        this.add(",");
      }
      if (!this.value(data(value, String(index)), depth)) {
        this.add("null");
      }
    }
    this.add("]");
  }
  private record(value: object, depth: number): void {
    this.add("{");
    let first = true;
    for (const key of Object.keys(value)) {
      const mark = { parts: this.parts.length, bytes: this.bytes };
      if (!first) {
        this.add(",");
      }
      this.string(key);
      this.add(":");
      if (this.value(data(value, key), depth)) {
        first = false;
      } else {
        this.parts.length = mark.parts;
        this.bytes = mark.bytes;
      }
    }
    this.add("}");
  }
}

export function boundedJson(value: unknown, budget: JsonBudget): Bounded {
  const writer = new Writer(budget);
  try {
    return writer.value(value, 0) ? { json: writer.text() } : { unavailable: "unsupported" };
  } catch (error) {
    // Getters, proxies and revoked proxies are untrusted tool data, not observer failures.
    return { unavailable: error instanceof Limit ? error.reason : "unreadable" };
  }
}
