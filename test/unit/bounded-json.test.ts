import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedJson } from "../../src/shared/bounded-json.ts";

const budget = { bytes: 64 * 1024, nodes: 4096, depth: 32 };

test("bounded live previews serialize ordinary values exactly like JSON.stringify", () => {
  const shared = { reused: true };
  const values: unknown[] = [
    'plain "quoted" \\ \n \u2028 é 雪 😀',
    "\ud83d",
    0,
    -0,
    1.5e300,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    null,
    [],
    {},
    [1, undefined, () => 1, Symbol("s"), null],
    { kept: 1, gone: undefined, fn: () => 1, sym: Symbol("s"), nested: { a: [shared, shared] } },
    { 2: "two", 1: "one", b: "b", a: "a" },
    new Date(0),
    new Date(Number.NaN),
    Object.create({ inherited: true }, { own: { value: 1, enumerable: true } }),
  ];
  for (const value of values) {
    assert.deepEqual(boundedJson(value, budget), { json: JSON.stringify(value) });
  }
});

test("bounded live previews classify values they cannot or should not serialize", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const throwing = Object.defineProperty({}, "boom", {
    enumerable: true,
    get() {
      throw new Error("hostile");
    },
  });
  let deep: unknown = "leaf";
  for (let depth = 0; depth < 40; depth++) {
    deep = [deep];
  }
  const cases: Array<[unknown, string]> = [
    [cyclic, "cyclic"],
    [{ list: [cyclic] }, "cyclic"],
    [proxy, "unsupported"],
    [throwing, "unsupported"],
    [{ big: 1n }, "unsupported"],
    [new Uint8Array(4), "unsupported"],
    [new ArrayBuffer(4), "unsupported"],
    [{ toJSON: () => "custom" }, "unsupported"],
    [undefined, "unsupported"],
    ["x".repeat(budget.bytes), "oversize"],
    ["雪".repeat(budget.bytes / 3), "oversize"],
    [Array.from({ length: budget.nodes + 1 }, () => 0), "oversize"],
    [deep, "oversize"],
  ];
  for (const [value, unavailable] of cases) {
    assert.deepEqual(boundedJson(value, budget), { unavailable });
  }
});

test("bounded live previews never run accessors, proxy traps or custom serializers", () => {
  let calls = 0;
  const run = (): string => {
    calls++;
    return "ran";
  };
  const traps = {
    get: run,
    ownKeys: () => [run()],
    getPrototypeOf: () => {
      run();
      return null;
    },
  };
  const values: unknown[] = [
    Object.defineProperty({}, "lazy", { enumerable: true, get: run }),
    Object.defineProperty([1], "0", { enumerable: true, get: run }),
    new Proxy({}, traps),
    { nested: [new Proxy([], traps)] },
    Object.defineProperty({}, "toJSON", { get: run }),
  ];
  for (const value of values) {
    assert.deepEqual(boundedJson(value, budget), { unavailable: "unsupported" });
  }
  const date = Object.assign(new Date(0), { getTime: run, toISOString: run });
  assert.deepEqual(boundedJson(date, budget), { json: '"1970-01-01T00:00:00.000Z"' });
  assert.equal(calls, 0);
});
