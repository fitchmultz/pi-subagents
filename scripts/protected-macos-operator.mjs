import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { dirname, join, resolve } from "node:path";
import koffi from "koffi";

export function privateFile(path) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
    "Operator file must be owned, private and nonsymlinked",
  );
}
export function loadState(path) {
  privateFile(path);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.version, 1);
  assert.match(state.owner, /^protected-[a-f0-9]{8}$/);
  assert.equal(resolve(state.root, "state.json"), path);
  const root = lstatSync(state.root);
  assert.ok(root.isDirectory() && root.uid === process.getuid() && (root.mode & 0o077) === 0);
  for (const key of ["tart", "tartHome", "key", "knownHosts", "private", "qualification"]) {
    assert.ok(
      typeof state[key] === "string" &&
        realpathSync(state[key]).startsWith(`${realpathSync(state.root)}/`),
    );
  }
  assert.match(state.baseline, new RegExp(`^${state.owner}-qualified(?:-[a-f0-9]{8})?$`));
  assert.equal(state.bootstrap, `${state.owner}-bootstrap`);
  assert.ok(isIPv4(state.gateway));
  privateFile(state.private);
  if (state.observer) {
    for (const key of ["binary", "manifest"]) {
      assert.ok(
        typeof state.observer[key] === "string" &&
          realpathSync(state.observer[key]).startsWith(`${realpathSync(state.root)}/`),
      );
      privateFile(state.observer[key]);
    }
    assert.match(state.observer.sha256, /^[a-f0-9]{64}$/);
  }
  return state;
}
export function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.new`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function writeReceipt(state, name, receipt) {
  const owner = state.active?.name ?? state.bootstrap;
  writeFileSync(join(state.root, `${owner}.${name}.json`), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
}
function staleOwner(path, owner) {
  privateFile(path);
  const record = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(record.owner, owner);
  assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
  assert.throws(
    () => process.kill(record.pid, 0),
    { code: "ESRCH" },
    "A live or reused operator PID retains ownership",
  );
}
function recoverLegacy(root, owner, command) {
  const directory = join(root, "operator.lock");
  if (!existsSync(directory)) {
    return;
  }
  assert.ok(
    ["settle", "controller", "run"].includes(command),
    "Only recovery owners reclaim interrupted ownership",
  );
  assert.deepEqual(
    readdirSync(directory),
    ["owner.json"],
    "Unknown legacy lock contents retain the entire lock",
  );
  staleOwner(join(directory, "owner.json"), owner);
  unlinkSync(join(directory, "owner.json"));
  rmdirSync(directory);
}
// One never-unlinked inode is kernel-locked before owner recovery or journal read.
// Unlike rename/mkdir takeover, concurrent settlers cannot replace a live lock.
export function operatorLock(path, command) {
  const discovery = loadState(path);
  const guard = join(dirname(path), "operator.guard");
  const fd = openSync(
    guard,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  const system = koffi.load(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  );
  const flock = system.func("int flock(int fd, int operation)");
  const ownerPath = join(discovery.root, "operator.owner.json");
  try {
    privateFile(guard);
    assert.equal(flock(fd, 6), 0, "Another operator owns the kernel-exclusive guard");
    recoverLegacy(discovery.root, discovery.owner, command);
    if (existsSync(ownerPath)) {
      assert.ok(
        ["settle", "controller", "run"].includes(command),
        "Only recovery owners reclaim interrupted ownership",
      );
      staleOwner(ownerPath, discovery.owner);
    }
    // The discovery snapshot is never used by an operation after admission.
    const state = loadState(path);
    assert.equal(state.owner, discovery.owner);
    writeFileSync(ownerPath, JSON.stringify({ owner: state.owner, pid: process.pid }), {
      mode: 0o600,
    });
    return {
      state,
      release() {
        try {
          unlinkSync(ownerPath);
        } finally {
          closeSync(fd);
        }
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
