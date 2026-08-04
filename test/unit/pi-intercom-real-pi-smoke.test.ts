import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../scripts/real-pi-smoke.mjs", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf-8" });
}

test("real Pi smoke CLI preserves help and invalid-argument behavior", () => {
  for (const args of [
    ["--help"],
    ["-h"],
    ["--help", "--bad"],
    ["--llm", "--keep-temp", "--help"],
    ["--llm", "--llm", "-h"],
    ["--timeout-ms=123", "--timeout-ms=456", "--help"],
    ["--timeout-ms=123", "--help"],
    ["--timeout-ms", "123", "--help"],
    ["--timeout-ms=9007199254740991", "--help"],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, args.join(" "));
    assert.match(result.stdout, /^Usage:/);
  }

  for (const args of [
    ["--bad", "--help"],
    ["-hh"],
    ["--"],
    ["--timeout-ms"],
    ["--timeout-ms", "--help"],
    ["--timeout-ms="],
    ["--timeout-ms=0"],
    ["--timeout-ms=0", "--help"],
    ["--timeout-ms=0", "--timeout-ms=123", "--help"],
    ["--timeout-ms=9007199254740992"],
    ["--timeout-ms", "nope"],
    ["--llm=value"],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /\[real-pi-smoke\]/);
    assert.match(result.stdout, /^Usage:/);
  }

  assert.match(run("--bad", "-hh").stderr, /Unknown option: --bad/);
  assert.match(run("-hh", "--bad").stderr, /Unknown option: -hh/);
  assert.match(run("--").stderr, /Unknown option: --/);
});
