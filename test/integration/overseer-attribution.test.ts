import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  escalationSchema,
  processSchema,
  resultSchema,
  type Launch,
} from "../../src/agent/contracts.ts";
import { loadSDK } from "../../src/agent/host.ts";
import { ensureActor, ownIdentity } from "../../src/agent/process.ts";
import { enqueue, ownerDirectory, read, runDirectory, write } from "../../src/agent/storage.ts";
import { nativeSdkRoot } from "../support/native-sdk.ts";
import { dead, until } from "../support/observation-child.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const fixture = path.join(repo, "test/fixtures/overseer-attribution-provider.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function clone() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/ovr-attribution-"));
  const upstream = path.join(root, "upstream");
  const cwd = path.join(root, "checkout");
  git(root, "init", "-b", "main", upstream);
  git(upstream, "config", "user.name", "Test");
  git(upstream, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(upstream, "upstream.txt"), "initial\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "initial");
  git(root, "clone", upstream, cwd);
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.com");
  const upstreamCommit = (content: string) => {
    fs.writeFileSync(path.join(upstream, "upstream.txt"), content);
    git(upstream, "commit", "-am", content.trim());
  };
  return { root, cwd, upstreamCommit };
}

async function startChild(
  t: TestContext,
  root: string,
  cwd: string,
  contract: NonNullable<Launch["contract"]>,
) {
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [fixture],
      defaultProjectTrust: "always",
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  const sdkRoot = nativeSdkRoot(process.env.PI_COMPAT_EXPECTED_PACKAGE_DIR);
  const sdk = await loadSDK(sdkRoot);
  const owner = "attribution-parent";
  const id = randomUUID();
  const base = ownerDirectory(agentDir, owner);
  const directory = runDirectory(base, id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manager = sdk.SessionManager.create(cwd, directory);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile !== undefined);
  fs.writeFileSync(sessionFile, `${JSON.stringify(manager.getHeader())}\n`, { flag: "wx" });
  const launch: Launch = {
    version: 1,
    id,
    rootId: id,
    owner,
    cwd,
    agentDir,
    sdk: sdkRoot,
    entry: path.join(repo, "src/agent/index.ts"),
    sessionFile,
    sessionId: manager.getSessionId(),
    prompt: "Follow the scripted Git steps.",
    context: "fresh",
    provider: "attribution-fixture",
    model: "native-attribution",
    thinking: "off",
    trusted: true,
    createdAt: Date.now(),
    contract,
    overseer: { enabled: true, judge: "off" },
  };
  write(path.join(directory, "launch.json"), launch, true);
  const attached = (value: boolean) => {
    write(path.join(base, "attachment.json"), {
      ...ownIdentity(),
      generation: "attribution-test",
      attached: value,
    });
  };
  attached(true);
  t.after(async () => {
    const actor = read(path.join(directory, "actor.lock", "process.json"), processSchema);
    try {
      attached(false);
      if (actor !== undefined) {
        await until(() => dead(actor.pid), "actor exit", 10_000);
      }
    } finally {
      if (actor !== undefined && !dead(actor.pid)) {
        process.kill(-actor.pid, "SIGKILL");
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const saved = { ...process.env };
  try {
    process.env.PI_OFFLINE = "1";
    process.env.OVERSEER_ATTRIBUTION_STEPS = root;
    await ensureActor(base, launch);
  } finally {
    for (const key of ["PI_OFFLINE", "OVERSEER_ATTRIBUTION_STEPS"]) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
  enqueue(base, launch, { action: "run" });
  const escalation = () => read(path.join(directory, "escalation.json"), escalationSchema);
  const result = () => read(path.join(directory, "result.json"), resultSchema);
  return {
    async step(index: number, command: string, before?: () => void) {
      const ready = () => fs.existsSync(path.join(root, `${index}.ready`));
      await until(() => ready() || escalation() !== undefined || result() !== undefined, "step");
      assert.equal(escalation(), undefined, `unexpected pause before step ${index}`);
      assert.ok(ready(), `child ended before step ${index}`);
      before?.();
      fs.writeFileSync(path.join(root, "pending.command"), command);
      fs.renameSync(path.join(root, "pending.command"), path.join(root, `${index}.command`));
    },
    async completed() {
      await until(() => result() !== undefined || escalation() !== undefined, "completion");
      assert.equal(escalation(), undefined, "unexpected pause at final checkpoint");
      const savedResult = result();
      assert.equal(savedResult?.status, "completed");
      return savedResult;
    },
  };
}

nodeTest(
  "read-only native child stays unpaused and reports no changes across external fast-forwards",
  async (t) => {
    const { root, cwd, upstreamCommit } = clone();
    const child = await startChild(t, root, cwd, {
      scope: [],
      verification: ["git status --short"],
    });
    for (const index of [0, 1]) {
      await child.step(index, "git status --short", () => {
        upstreamCommit(`upstream ${index}\n`);
        git(cwd, "pull", "--ff-only");
        assert.equal(git(cwd, "status", "--porcelain"), "");
      });
    }
    await child.step(2, "");
    assert.equal((await child.completed()).changedFiles, undefined);
  },
);

nodeTest(
  "native writer only reports task work after a soft reset and restore against newer upstream",
  async (t) => {
    const { root, cwd, upstreamCommit } = clone();
    const worktree = path.join(root, "task-worktree");
    git(cwd, "worktree", "add", "--track", "-b", "task", worktree, "origin/main");
    const child = await startChild(t, root, worktree, {
      scope: ["task"],
      verification: ["git status --short"],
      baseBranch: "origin/main",
    });
    // A large scoped diff passes the regular judge checkpoint before the reset.
    await child.step(
      0,
      "git fetch origin main && mkdir task && seq 1 130 > task/edit.txt && git add task && git commit -m 'task work' && git rebase FETCH_HEAD",
      () => upstreamCommit("first upstream version\n"),
    );
    await child.step(1, "git reset --soft origin/main", () => {
      upstreamCommit("second upstream version\n");
      git(cwd, "pull", "--ff-only");
    });
    await child.step(2, "git reset HEAD && git checkout HEAD -- upstream.txt", () => {
      assert.equal(
        git(worktree, "diff", "--cached", "--name-only"),
        "task/edit.txt\nupstream.txt\n",
      );
    });
    await child.step(3, "", () => {
      assert.equal(
        git(worktree, "status", "--porcelain", "--untracked-files=all"),
        "?? task/edit.txt\n",
      );
      assert.equal(git(worktree, "rev-parse", "HEAD"), git(cwd, "rev-parse", "origin/main"));
    });
    assert.deepEqual((await child.completed()).changedFiles, ["task/edit.txt"]);
  },
);
