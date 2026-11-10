import "../support/isolated-home.ts";
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  filterProjectSessions,
  formatSessionTarget,
  resolveSessionProjectId,
  resolveSessionTarget,
  targetDisplayName,
} from "../../src/pi-intercom/session-targets.ts";
import {
  formatDeviceListings,
  formatSessionListSections,
} from "../../src/pi-intercom/ui/session-format.ts";
import type { SessionInfo } from "../../src/pi-intercom/types.ts";

const sessions = [
  { id: "abcdefgh-1111-2222-3333-444444444444", name: "worker" },
  { id: "abcdefgi-1111-2222-3333-444444444444", name: "reviewer" },
  { id: "xyz00000-1111-2222-3333-444444444444", name: "abcdefgh" },
] as const;

nodeTest("formatSessionTarget returns the shortest safe prefix across ids and names", () => {
  assert.equal(formatSessionTarget(sessions[0], sessions), "abcdefgh-");
  assert.equal(formatSessionTarget(sessions[1], sessions), "abcdefgi");
});

nodeTest("targetDisplayName adds a safe target when a name collides with another id prefix", () => {
  assert.equal(targetDisplayName(sessions[2], sessions), "abcdefgh (xyz00000)");
});

nodeTest("resolveSessionTarget rejects too-short id prefixes with a specific status", () => {
  const resolution = resolveSessionTarget(sessions, "abcdefg");
  assert.equal(resolution.status, "prefix_too_short");
  assert.deepEqual(
    resolution.matches.map((session) => session.id).sort(),
    [sessions[0].id, sessions[1].id].sort(),
  );
});

nodeTest("resolveSessionTarget resolves safe prefixes and reports name-prefix ambiguity", () => {
  assert.deepEqual(resolveSessionTarget(sessions, "abcdefgi").target, sessions[1]);
  const ambiguous = resolveSessionTarget(sessions, "abcdefgh");
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(
    ambiguous.matches.map((session) => session.id).sort(),
    [sessions[0].id, sessions[2].id].sort(),
  );
});

nodeTest("resolveSessionTarget accepts an exact short name that only overlaps its own id", () => {
  const selfOverlap = [{ id: "abcdefghi-1111-2222-3333-444444444444", name: "abc" }];
  const resolution = resolveSessionTarget(selfOverlap, "abc");
  assert.equal(resolution.status, "found");
  assert.equal(resolution.target, selfOverlap[0]);
});

nodeTest("resolveSessionProjectId matches a repository and linked worktree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-intercom-project-"));
  try {
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature-worktree");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "README.md"), "test\n");
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "initial",
      ],
      { stdio: "ignore" },
    );
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", worktree, "HEAD"], {
      stdio: "ignore",
    });
    mkdirSync(path.join(worktree, "src"), { recursive: true });

    assert.equal(
      await resolveSessionProjectId(path.join(repo, "src")),
      await resolveSessionProjectId(path.join(worktree, "src")),
    );
    assert.notEqual(
      await resolveSessionProjectId(repo),
      await resolveSessionProjectId(path.join(root, "unrelated")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

nodeTest("resolveSessionProjectId ignores inherited Git repository overrides", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-intercom-git-env-"));
  const previous = new Map(
    ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"].map((key) => [key, process.env[key]]),
  );
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
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

nodeTest("resolveSessionProjectId runs Git outside the project checkout", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-intercom-git-cwd-"));
  const previousPath = process.env.PATH;
  try {
    const fakeBin = path.join(root, "bin");
    const project = path.join(root, "untrusted-project");
    const capturedCwd = path.join(root, "cwd.txt");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(capturedCwd)}, process.cwd());\nconsole.log(${JSON.stringify(path.join(root, "common.git"))});\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;

    await resolveSessionProjectId(project);
    assert.equal(readFileSync(capturedCwd, "utf8"), path.dirname(process.execPath));
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

nodeTest("filterProjectSessions includes the current checkout and linked worktrees only", () => {
  const projectSessions = filterProjectSessions(
    [
      { id: "current", cwd: "/repo", projectId: "project-a" },
      { id: "same-cwd", cwd: "/repo", projectId: "cwd-fallback" },
      { id: "worktree", cwd: "/worktrees/feature", projectId: "project-a" },
      { id: "unrelated", cwd: "/other", projectId: "project-b" },
    ],
    "current",
  );

  assert.deepEqual(
    projectSessions.map((session) => session.id),
    ["current", "same-cwd", "worktree"],
  );
  assert.deepEqual(filterProjectSessions(projectSessions, "missing"), []);
});

nodeTest("resolveSessionTarget rejects exact names that are unsafe too-short id prefixes", () => {
  const unsafe = [
    { id: "abcdefghi-1111-2222-3333-444444444444", name: "worker" },
    { id: "xyz00000-1111-2222-3333-444444444444", name: "abcdefg" },
  ] as const;
  const ambiguous = resolveSessionTarget(unsafe, "abcdefg");
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(
    ambiguous.matches.map((session) => session.id).sort(),
    [unsafe[0].id, unsafe[1].id].sort(),
  );
});

nodeTest(
  "formatSessionListSections tags case-folded duplicates across hidden projects, not unique or empty names",
  () => {
    const session = (id: string, name: string, cwd: string, projectId: string) => ({
      id,
      name,
      cwd,
      projectId,
      model: "fixture",
    });
    const listing = formatSessionListSections(
      [
        session("aaaaaaaa-1111", "Worker", "/repo", "project-a"),
        session("bbbbbbbb-1111", "worker", "/other", "project-b"),
        session("cccccccc-1111", "solo", "/repo", "project-a"),
        session("dddddddd-1111", "", "/repo", "project-a"),
        session("eeeeeeee-1111", "", "/repo", "project-a"),
      ],
      "aaaaaaaa-1111",
      { scope: "project" },
    );

    assert.match(listing, /• Worker \(aaaaaaaa\) — .*\[self, target:aaaaaaaa, /);
    assert.match(listing, /• solo \(cccccccc\) — /);
    assert.match(listing, /• Unnamed session \(dddddddd\) — /);
    assert.match(listing, /• Unnamed session \(eeeeeeee\) — /);
    assert.match(listing, /1 session in other projects hidden/);
    assert.doesNotMatch(listing, /target:(?:bbbbbbbb|cccccccc|dddddddd|eeeeeeee)/);
  },
);

nodeTest(
  "formatSessionListSections lists mains by project then name, then counts the caller's children",
  () => {
    const project = "a".repeat(64);
    const child = { rootSessionId: "lead-root", parentSessionId: "lead-root" };
    const peer = (id: string, name: string, cwd: string, extra: Partial<SessionInfo> = {}) => ({
      id,
      name,
      cwd,
      model: "fixture",
      ...extra,
    });
    // Broker order: mains and children interleaved, as registration left them.
    const group = [
      peer("lead0000-1", "lead", "/work/api", { projectId: project, rootSessionId: "lead-root" }),
      peer("kid10000-1", "kid-idle", "/work/api", { ...child, acceptsAsks: true }),
      peer("zeta0000-1", "zeta", "/work/web", { projectId: "b".repeat(64) }),
      peer("kid20000-1", "kid-busy", "/work/web", { ...child, acceptsAsks: false }),
      peer("beta0000-1", "Beta", "/worktrees/api-fix", { projectId: project }),
      peer("remote-0001", "bridge-bot", "/work"),
      peer("kid30000-1", "kid-unknown", "/work/api", child),
      peer("alph0000-1", "alpha", "/work/api", { projectId: project }),
      peer("kid40000-1", "kid-idle-2", "/work/api", { ...child, status: "idle" }),
    ];
    const rowNames = (block = "") => [...block.matchAll(/^• (.+?) \(/gm)].map((match) => match[1]);
    const counted = /^\*\*Child sessions in your group \(4: 2 idle, 1 busy, 1 unknown\):\*\*/;

    const [current, mains, summary] = formatSessionListSections(group, "lead0000-1").split("\n\n");
    assert.deepEqual(rowNames(current), ["lead"]);
    assert.match(mains ?? "", /^\*\*Other main sessions \(4\):\*\*\n/);
    // Beta's worktree path sorts last, but it shares alpha's project, so it sits beside alpha.
    assert.deepEqual(rowNames(mains), ["bridge-bot", "alpha", "Beta", "zeta"]);
    assert.match(summary ?? "", counted);
    assert.deepEqual(rowNames(summary), []);
    assert.ok((summary ?? "").includes('`intercom({ action: "list", children: true })`'));

    const [, , rows] = formatSessionListSections(group, "lead0000-1", { children: true }).split(
      "\n\n",
    );
    assert.match(rows ?? "", counted);
    assert.deepEqual(rowNames(rows), ["kid-idle", "kid-busy", "kid-unknown", "kid-idle-2"]);

    const projectOnly = formatSessionListSections(group, "lead0000-1", { scope: "project" });
    assert.match(projectOnly, /\*\*Child sessions in your group \(3: 2 idle, 1 unknown\):\*\* /);
    assert.ok(
      projectOnly.includes('`intercom({ action: "list", scope: "project", children: true })`'),
    );

    const mainsOnly = group.filter((session) => session.parentSessionId === undefined);
    assert.doesNotMatch(formatSessionListSections(mainsOnly, "lead0000-1"), /child sessions/i);
    assert.match(
      formatSessionListSections(mainsOnly, "lead0000-1", { children: true }),
      /\n\n\*\*Child sessions in your group \(0\):\*\*\n\n/,
    );
  },
);

nodeTest(
  "formatDeviceListings prints one block per device: name@device rows, no sessions, each failure",
  () => {
    // A fixed device clock far from this machine's: ages must come from the device's `now`.
    const now = 1_000_000_000;
    const peer = (id: string, name: string, cwd: string, extra: Partial<SessionInfo>) => ({
      id,
      name,
      cwd,
      model: "fixture",
      ...extra,
    });
    const busy = {
      status: "tool:bash",
      acceptsAsks: false,
      pendingAsks: 0,
      lastSeen: now - 5_000,
      lastIntercomActivity: 0,
    };
    const listings = [
      {
        device: "laptop",
        now,
        sessions: [
          peer("pi-bbbbbbbb1", "web-build", "/work/web", busy),
          peer("pi-aaaaaaaa1", "api-fix", "/work/api", {
            status: "idle",
            acceptsAsks: true,
            pendingAsks: 1,
            lastSeen: now - 7_200_000,
            lastIntercomActivity: now - 120_000,
          }),
          peer("pi-cccccccc1", "Web-Build", "/work/web", busy),
        ],
      },
      { device: "desk", now, sessions: [] },
      { device: "phone", failure: "unreachable (connect to host phone port 22: timed out)" },
      { device: "old-box", failure: "not listed: its pi-subagents has no cross-device command" },
    ];
    const busyTags =
      "state:busy, accepts_asks:false, pending_asks:0, last_intercom_activity:none, last_seen:5s ago";
    const footer =
      "**Other devices:** list only. send, ask and last reach the sessions of this device.";
    assert.equal(
      formatDeviceListings(listings),
      [
        "**Main sessions on laptop (3):**",
        "• api-fix@laptop (pi-aaaaa@laptop) — Native session cwd: /work/api (fixture) [idle, state:idle, accepts_asks:true, pending_asks:1, last_intercom_activity:2m ago, last_seen:2h ago]",
        `• web-build@laptop (pi-bbbbb@laptop) — Native session cwd: /work/web (fixture) [tool:bash, target:pi-bbbbb@laptop, ${busyTags}]`,
        `• Web-Build@laptop (pi-ccccc@laptop) — Native session cwd: /work/web (fixture) [tool:bash, target:pi-ccccc@laptop, ${busyTags}]`,
        "",
        "**Main sessions on desk (0):** no Pi session is connected there.",
        "",
        "**phone:** unreachable (connect to host phone port 22: timed out)",
        "",
        "**old-box:** not listed: its pi-subagents has no cross-device command",
        "",
        footer,
      ].join("\n"),
    );
    assert.equal(
      formatDeviceListings(listings.slice(0, 2), " API "),
      [
        '**Main sessions on laptop matching "API" (1 of 3):**',
        "• api-fix@laptop (pi-aaaaa@laptop) — Native session cwd: /work/api (fixture) [idle, state:idle, accepts_asks:true, pending_asks:1, last_intercom_activity:2m ago, last_seen:2h ago]",
        "",
        "**Main sessions on desk (0):** no Pi session is connected there.",
        "",
        footer,
      ].join("\n"),
    );
  },
);
