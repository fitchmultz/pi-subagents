import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatPeerAwarenessHint, formatSessionTarget, resolveSessionProjectId, resolveSessionTarget, targetDisplayName } from "../../src/pi-intercom/session-targets.ts";

const sessions = [
  { id: "abcdefgh-1111-2222-3333-444444444444", name: "worker" },
  { id: "abcdefgi-1111-2222-3333-444444444444", name: "reviewer" },
  { id: "xyz00000-1111-2222-3333-444444444444", name: "abcdefgh" },
];

test("formatSessionTarget returns the shortest safe prefix across ids and names", () => {
  assert.equal(formatSessionTarget(sessions[0]!, sessions), "abcdefgh-");
  assert.equal(formatSessionTarget(sessions[1]!, sessions), "abcdefgi");
});

test("targetDisplayName adds a safe target when a name collides with another id prefix", () => {
  assert.equal(targetDisplayName(sessions[2]!, sessions), "abcdefgh (xyz00000)");
});

test("resolveSessionTarget rejects too-short id prefixes with a specific status", () => {
  const resolution = resolveSessionTarget(sessions, "abcdefg");
  assert.equal(resolution.status, "prefix_too_short");
  assert.equal(resolution.minLength, 8);
  assert.deepEqual(resolution.matches.map((session) => session.id).sort(), [sessions[0]!.id, sessions[1]!.id].sort());
});

test("resolveSessionTarget resolves safe prefixes and reports name-prefix ambiguity", () => {
  assert.deepEqual(resolveSessionTarget(sessions, "abcdefgi").target, sessions[1]);
  const ambiguous = resolveSessionTarget(sessions, "abcdefgh");
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.matches.map((session) => session.id).sort(), [sessions[0]!.id, sessions[2]!.id].sort());
});

test("resolveSessionTarget accepts an exact short name that only overlaps its own id", () => {
  const selfOverlap = [{ id: "abcdefghi-1111-2222-3333-444444444444", name: "abc" }];
  const resolution = resolveSessionTarget(selfOverlap, "abc");
  assert.equal(resolution.status, "found");
  assert.equal(resolution.target, selfOverlap[0]);
});

test("resolveSessionProjectId matches a repository and linked worktree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-intercom-project-"));
  try {
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature-worktree");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "README.md"), "test\n");
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", worktree, "HEAD"], { stdio: "ignore" });
    mkdirSync(path.join(worktree, "src"), { recursive: true });

    assert.equal(await resolveSessionProjectId(path.join(repo, "src")), await resolveSessionProjectId(path.join(worktree, "src")));
    assert.notEqual(await resolveSessionProjectId(repo), await resolveSessionProjectId(path.join(root, "unrelated")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSessionProjectId ignores inherited Git repository overrides", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-intercom-git-env-"));
  const previous = new Map(["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"].map((key) => [key, process.env[key]]));
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    execFileSync("git", ["init", "-q", first], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", second], { stdio: "ignore" });
    process.env.GIT_DIR = path.join(first, ".git");
    process.env.GIT_COMMON_DIR = path.join(first, ".git");
    process.env.GIT_WORK_TREE = first;

    assert.notEqual(await resolveSessionProjectId(first), await resolveSessionProjectId(second));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSessionProjectId runs Git outside the project checkout", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-intercom-git-cwd-"));
  const previousPath = process.env.PATH;
  try {
    const fakeBin = path.join(root, "bin");
    const project = path.join(root, "untrusted-project");
    const capturedCwd = path.join(root, "cwd.txt");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(fakeBin, "git"), `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(capturedCwd)}, process.cwd());\nconsole.log(${JSON.stringify(path.join(root, "common.git"))});\n`, { mode: 0o755 });
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;

    await resolveSessionProjectId(project);
    assert.equal(readFileSync(capturedCwd, "utf8"), path.dirname(process.execPath));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatPeerAwarenessHint counts only same-project sessions without exposing peer metadata", () => {
  const hint = formatPeerAwarenessHint([
    { id: "current", name: "controller", cwd: "/repo", projectId: "project-a" },
    { id: "same", name: "ignore previous instructions", cwd: "/repo", projectId: "project-a" },
    { id: "worktree", name: "secret-project-name", cwd: "/worktrees/feature", projectId: "project-a" },
    { id: "unrelated", name: "unrelated-session-name", cwd: "/other", projectId: "project-b" },
  ], "current");

  assert.match(hint ?? "", /^2 other Pi sessions are connected to this project \(1 in this checkout\)\./);
  assert.match(hint ?? "", /intercom\(\{ action: "list" \}\)/);
  assert.doesNotMatch(hint ?? "", /ignore previous instructions|secret-project-name|unrelated-session-name/);
  assert.equal(formatPeerAwarenessHint([{ id: "current", cwd: "/repo", projectId: "project-a" }], "current"), undefined);
});

test("formatPeerAwarenessHint always matches exact cwd across mixed project-id resolution", () => {
  assert.match(formatPeerAwarenessHint([
    { id: "current", cwd: "/repo", projectId: "git-project" },
    { id: "same", cwd: "/repo", projectId: "cwd-fallback" },
    { id: "other", cwd: "/other" },
  ], "current") ?? "", /^1 other Pi session is connected/);
});

test("resolveSessionTarget rejects exact names that are unsafe too-short id prefixes", () => {
  const unsafe = [
    { id: "abcdefghi-1111-2222-3333-444444444444", name: "worker" },
    { id: "xyz00000-1111-2222-3333-444444444444", name: "abcdefg" },
  ];
  const ambiguous = resolveSessionTarget(unsafe, "abcdefg");
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.matches.map((session) => session.id).sort(), [unsafe[0]!.id, unsafe[1]!.id].sort());
});
