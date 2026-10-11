import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  captureSingleOutputSnapshot,
  finalizeSingleOutput,
  formatSavedOutputReference,
  normalizeSingleOutputOverride,
  resolveSingleOutput,
  resolveSingleOutputPath,
  findDuplicateOutputPath,
} from "../../src/runs/shared/single-output.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined || dir.length === 0) {
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeSingleOutputOverride", () => {
  it("treats boolean and string false as disabled output", () => {
    assert.equal(normalizeSingleOutputOverride(false, "default.md"), false);
    assert.equal(normalizeSingleOutputOverride("false", "default.md"), false);
  });

  it("treats boolean and string true as the configured default output", () => {
    assert.equal(normalizeSingleOutputOverride(true, "default.md"), "default.md");
    assert.equal(normalizeSingleOutputOverride("true", "default.md"), "default.md");
    assert.equal(normalizeSingleOutputOverride("true", undefined), undefined);
  });

  it("passes explicit non-empty output paths through", () => {
    assert.equal(normalizeSingleOutputOverride("reports/out.md", "default.md"), "reports/out.md");
    assert.equal(normalizeSingleOutputOverride("", "default.md"), undefined);
    assert.equal(normalizeSingleOutputOverride(undefined, "default.md"), undefined);
  });
});

describe("resolveSingleOutputPath", () => {
  it("does not resolve disabled or boolean-like output values", () => {
    assert.equal(resolveSingleOutputPath(false, "/repo"), undefined);
    assert.equal(resolveSingleOutputPath("false", "/repo"), undefined);
    assert.equal(resolveSingleOutputPath(true, "/repo"), undefined);
    assert.equal(resolveSingleOutputPath("true", "/repo"), undefined);
  });

  it("keeps absolute paths unchanged", () => {
    const absolutePath = path.join(os.tmpdir(), "pi-subagents-abs", "report.md");
    const resolved = resolveSingleOutputPath(absolutePath, "/repo", "/override");
    assert.equal(resolved, absolutePath);
  });

  it("resolves relative paths against requested cwd", () => {
    const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "/requested");
    assert.equal(resolved, path.resolve("/requested", "reviews/report.md"));
  });

  it("resolves relative paths against runtime cwd when requested cwd is absent", () => {
    const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime");
    assert.equal(resolved, path.resolve("/runtime", "reviews/report.md"));
  });

  it("resolves relative requested cwd from runtime cwd before resolving output", () => {
    const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "nested/work");
    assert.equal(resolved, path.resolve("/runtime", "nested/work", "reviews/report.md"));
  });
});

describe("resolveSingleOutput", () => {
  it("keeps an identical agent rewrite instead of replacing it with receipt text", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
    tempDirs.push(dir);
    const outputPath = path.join(dir, "review.md");
    fs.writeFileSync(outputPath, "real file content", "utf-8");
    const before = captureSingleOutputSnapshot(outputPath);

    fs.writeFileSync(outputPath, "real file content", "utf-8");
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(outputPath, future, future);

    const result = resolveSingleOutput(outputPath, "receipt text", before);
    assert.equal(result.fullOutput, "real file content");
    assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
  });

  it("preserves read errors from changed output paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
    tempDirs.push(dir);
    const outputPath = path.join(dir, "review.md");
    const before = captureSingleOutputSnapshot(outputPath);

    fs.mkdirSync(outputPath);
    const result = resolveSingleOutput(outputPath, "fallback output", before);

    assert.equal(result.fullOutput, "fallback output");
    assert.equal(result.savedPath, undefined);
    assert.match(result.saveError ?? "", /Failed to read changed output file/);
  });
});

describe("formatSavedOutputReference", () => {
  it("includes absolute path, human-readable size, and line count", () => {
    const reportPath = path.join(os.tmpdir(), "report.md");
    const ref = formatSavedOutputReference(reportPath, "line 1\nline 2");
    assert.equal(ref.path, path.resolve(reportPath));
    assert.equal(ref.bytes, Buffer.byteLength("line 1\nline 2", "utf-8"));
    assert.equal(ref.lines, 2);
    assert.equal(
      ref.message,
      `Output saved to: ${ref.path} (13 B, 2 lines). Read this file if needed.`,
    );
  });

  it("formats larger byte sizes in KB", () => {
    const ref = formatSavedOutputReference("/tmp/large.md", "a".repeat(49_357));
    assert.match(ref.message, /\(48\.2 KB, 1 line\)/);
  });
});

describe("finalizeSingleOutput", () => {
  it("formats saved-path messaging around the already-resolved output", () => {
    const result = finalizeSingleOutput({
      fullOutput: "line 1\nline 2\nline 3",
      truncatedOutput: "[TRUNCATED]\nline 1",
      outputPath: "/tmp/review.md",
      savedPath: "/tmp/review.md",
      exitCode: 0,
    });

    assert.match(result.displayOutput, /^\[TRUNCATED\]\nline 1/);
    assert.match(result.displayOutput, /Output saved to:/);
    assert.match(result.displayOutput, /3 lines/);
  });

  it("does not add save messaging on failed runs", () => {
    const result = finalizeSingleOutput({
      fullOutput: "full output",
      truncatedOutput: "truncated output",
      outputPath: "/tmp/review.md",
      savedPath: "/tmp/review.md",
      exitCode: 1,
    });

    assert.equal(result.displayOutput, "truncated output");
  });
});

describe("findDuplicateOutputPath", () => {
  it("reports colliding resolved output paths with 1-based task indexes", () => {
    assert.equal(
      findDuplicateOutputPath([{ agent: "a" }, { agent: "b", outputPath: "/tmp/only.md" }]),
      undefined,
    );
    const error = findDuplicateOutputPath([
      { agent: "reviewer", outputPath: "/tmp/same.md" },
      { agent: "worker" },
      { agent: "fixer", outputPath: "/tmp/same.md" },
    ]);
    assert.equal(
      error,
      "Parallel tasks 1 (reviewer) and 3 (fixer) resolve output to the same path: /tmp/same.md. Use distinct output paths.",
    );
  });
});
