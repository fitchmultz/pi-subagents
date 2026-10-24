#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";

/** @typedef {Readonly<{version: 1, ownerUid: number, source: string, archive: string, sourceParent: unknown, archiveParent: unknown, container: unknown, directory: unknown, members: unknown}>} ArchiveRecord */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const generation = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.sqlite$/;
const database =
  /^(?:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.sqlite(?:\.ingest\.sqlite)?|run-timing\.sqlite)$/;
const manifest = /^[a-f0-9]{64}\.json$/;
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

/**
 * @param {unknown} value
 * @returns {string}
 */
function absolute(value) {
  assert.ok(typeof value === "string" && path.isAbsolute(value), "E_ABSOLUTE_PATH");
  assert.ok(path.resolve(value) === value, "E_CANONICAL_PATH");
  return value;
}
/**
 * @param {import("node:fs").BigIntStats} stat
 */
function identity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
  };
}
/**
 * @param {import("node:fs").BigIntStats} stat
 */
function stamp(stat) {
  return {
    ...identity(stat),
    size: String(stat.size),
    nlink: String(stat.nlink),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}
/**
 * @param {import("node:fs").BigIntStats} stat
 * @param {number} uid
 */
function owned(stat, uid) {
  assert.ok(stat.uid === BigInt(uid), "E_FOREIGN_OWNER");
  assert.ok((stat.mode & 0o022n) === 0n, "E_UNSAFE_MODE");
}
/**
 * @param {string} file
 * @param {number} uid
 */
function trustedChain(file, uid) {
  let cursor = path.parse(file).root;
  const root = fs.lstatSync(cursor, { bigint: true });
  assert.ok(root.uid === 0n, "E_ANCESTOR_OWNER");
  assert.ok((root.mode & 0o022n) === 0n, "E_ANCESTOR_WRITABLE");
  for (const component of path.relative(cursor, file).split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor, { bigint: true });
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "E_PATH_LINK");
    assert.ok(stat.uid === 0n || stat.uid === BigInt(uid), "E_ANCESTOR_OWNER");
    if ((stat.mode & 0o022n) !== 0n) {
      assert.ok(stat.uid === 0n && (stat.mode & 0o1000n) !== 0n, "E_ANCESTOR_WRITABLE");
    }
  }
}
/**
 * @param {string} file
 * @param {number} uid
 * @param {boolean} [privateOnly]
 */
function directory(file, uid, privateOnly = false) {
  absolute(file);
  trustedChain(file, uid);
  assert.ok(fs.realpathSync(file) === file, "E_PATH_LINK");
  const stat = fs.lstatSync(file, { bigint: true });
  assert.ok(stat.isDirectory(), "E_DIRECTORY");
  owned(stat, uid);
  if (privateOnly) {
    assert.ok((stat.mode & 0o077n) === 0n, "E_PRIVATE_DIRECTORY");
  }
  return stat;
}
/**
 * @param {string} file
 */
function syncDirectory(file) {
  const fd = fs.openSync(file, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/**
 * @param {string} file
 */
function exists(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}
/**
 * @param {string} file
 * @param {string} root
 */
function outside(file, root) {
  assert.ok(file !== root && !file.startsWith(`${root}${path.sep}`), "E_OVERLAPPING_PATHS");
}
/**
 * @param {string} directoryPath
 */
function closed(directoryPath) {
  const executable = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
  const result = spawnSync(executable, ["-nPl", "-F", "p", "+d", directoryPath], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ok(result.error === undefined, "E_LSOF_REQUIRED");
  assert.ok(result.signal === null, "E_LSOF_INTERRUPTED");
  assert.ok(result.stderr === "", "E_LSOF_INCOMPLETE");
  assert.ok(result.stdout === "", "E_OPEN_HANDLES");
  assert.ok(result.status === 1, "E_LSOF_RESULT");
}
/**
 * @param {string} directoryPath
 * @param {string} name
 * @param {number} uid
 */
function member(directoryPath, name, uid) {
  const base = name.replace(/-(?:wal|shm)$/, "");
  assert.ok(database.test(base) || manifest.test(name), "E_UNKNOWN_MEMBER");
  const file = path.join(directoryPath, name);
  const before = fs.lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && before.nlink === 1n, "E_MEMBER_TYPE");
  owned(before, uid);
  const fd = fs.openSync(file, flags);
  try {
    assert.ok(
      isDeepStrictEqual(stamp(fs.fstatSync(fd, { bigint: true })), stamp(before)),
      "E_MEMBER_IDENTITY",
    );
    const sha256 = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      sha256.update(buffer.subarray(0, length));
    }
    assert.ok(
      isDeepStrictEqual(stamp(fs.fstatSync(fd, { bigint: true })), stamp(before)),
      "E_MEMBER_CHANGED",
    );
    assert.ok(
      isDeepStrictEqual(stamp(fs.lstatSync(file, { bigint: true })), stamp(before)),
      "E_MEMBER_PATH_CHANGED",
    );
    return { name, ...stamp(before), sha256: sha256.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}
/**
 * @param {string} directoryPath
 * @param {number} uid
 */
function inventory(directoryPath, uid) {
  directory(directoryPath, uid);
  const names = fs.readdirSync(directoryPath).toSorted();
  assert.ok(names.length > 0, "E_EMPTY_SET");
  const members = names.map((name) => member(directoryPath, name, uid));
  for (const name of names) {
    const base = name.replace(/-(?:wal|shm)$/, "");
    assert.ok(names.includes(base), "E_ORPHAN_COMPANION");
    assert.ok(names.includes(`${base}-wal`) === names.includes(`${base}-shm`), "E_INCOMPLETE_WAL");
    if (base.endsWith(".ingest.sqlite")) {
      assert.ok(names.includes(base.replace(/\.ingest\.sqlite$/, "")), "E_ORPHAN_INGEST");
    }
    if (manifest.test(name)) {
      const selected = readManifest(path.join(directoryPath, name));
      assert.ok(names.includes(selected), "E_MISSING_GENERATION");
    }
  }
  assert.ok(
    isDeepStrictEqual(fs.readdirSync(directoryPath).toSorted(), names),
    "E_MEMBERSHIP_CHANGED",
  );
  return members;
}
/**
 * @param {string} file
 */
function readManifest(file) {
  const fd = fs.openSync(file, flags);
  try {
    assert.ok(fs.fstatSync(fd).size <= 65_536, "E_MANIFEST_SIZE");
    /** @type {unknown} */
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    assert.ok(isRecord(parsed), "E_MANIFEST");
    const selected = parsed.file;
    assert.ok(typeof selected === "string" && generation.test(selected), "E_MANIFEST");
    return selected;
  } finally {
    fs.closeSync(fd);
  }
}
/**
 * @param {string} file
 * @param {number} uid
 * @returns {ArchiveRecord}
 */
function recordAt(file, uid) {
  directory(path.dirname(absolute(file)), uid, true);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    owned(stat, uid);
    assert.ok(stat.isFile() && stat.nlink === 1n && stat.size <= 16_777_216n, "E_RECORD_TYPE");
    assert.ok((stat.mode & 0o077n) === 0n, "E_PRIVATE_RECORD");
    /** @type {unknown} */
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    assert.ok(isRecord(parsed), "E_RECORD_TYPE");
    assert.ok(parsed.version === 1, "E_RECORD_VERSION");
    assert.ok(parsed.ownerUid === uid, "E_RECORD_OWNER");
    /** @type {ArchiveRecord} */
    const record = {
      version: 1,
      ownerUid: uid,
      source: absolute(parsed.source),
      archive: absolute(parsed.archive),
      sourceParent: parsed.sourceParent,
      archiveParent: parsed.archiveParent,
      container: parsed.container,
      directory: parsed.directory,
      members: parsed.members,
    };
    assert.ok(
      isDeepStrictEqual(stamp(fs.fstatSync(fd, { bigint: true })), stamp(stat)),
      "E_RECORD_CHANGED",
    );
    assert.ok(
      isDeepStrictEqual(stamp(fs.lstatSync(file, { bigint: true })), stamp(stat)),
      "E_RECORD_PATH_CHANGED",
    );
    assert.ok(path.basename(record.source) === "history-index", "E_SOURCE_NAME");
    outside(record.archive, record.source);
    outside(file, record.source);
    outside(file, record.archive);
    return record;
  } finally {
    fs.closeSync(fd);
  }
}
/**
 * @param {ArchiveRecord} record
 * @param {number} uid
 */
function parents(record, uid) {
  assert.ok(
    isDeepStrictEqual(identity(directory(path.dirname(record.source), uid)), record.sourceParent),
    "E_SOURCE_PARENT_CHANGED",
  );
  assert.ok(
    isDeepStrictEqual(
      identity(directory(path.dirname(record.archive), uid, true)),
      record.archiveParent,
    ),
    "E_ARCHIVE_PARENT_CHANGED",
  );
  assert.ok(
    isDeepStrictEqual(identity(directory(record.archive, uid, true)), record.container),
    "E_CONTAINER_CHANGED",
  );
  assert.ok(
    directory(path.dirname(record.source), uid).dev === directory(record.archive, uid, true).dev,
    "E_CROSS_DEVICE",
  );
}
/**
 * @param {ArchiveRecord} record
 * @param {number} uid
 */
function inspect(record, uid) {
  parents(record, uid);
  const destination = path.join(record.archive, "history-index");
  const sourceExists = exists(record.source);
  const destinationExists = exists(destination);
  assert.ok(sourceExists !== destinationExists, "E_AMBIGUOUS_PATHS");
  assert.ok(
    isDeepStrictEqual(
      fs.readdirSync(record.archive).toSorted(),
      destinationExists ? ["history-index"] : [],
    ),
    "E_UNEXPECTED_ARCHIVE_CONTAINER_CONTENTS",
  );
  const location = sourceExists ? record.source : destination;
  assert.ok(
    isDeepStrictEqual(identity(directory(location, uid)), record.directory),
    "E_SOURCE_CHANGED",
  );
  closed(location);
  assert.ok(isDeepStrictEqual(inventory(location, uid), record.members), "E_INVENTORY_CHANGED");
  closed(location);
  parents(record, uid);
  return sourceExists ? "prepared" : "archived";
}
/**
 * @param {string} file
 * @param {ArchiveRecord} record
 * @param {number} uid
 * @param {number} gid
 */
function saveRecord(file, record, uid, gid) {
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.fchownSync(fd, uid, gid);
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(path.dirname(file));
}
/**
 * @param {Readonly<{source?: string, archive?: string, record?: string}>} values
 * @param {number} uid
 */
function prepare(values, uid) {
  const source = absolute(values.source);
  const archive = absolute(values.archive);
  const file = absolute(values.record);
  assert.ok(path.basename(source) === "history-index", "E_SOURCE_NAME");
  outside(archive, source);
  outside(source, archive);
  outside(file, source);
  outside(file, archive);
  directory(path.dirname(file), uid, true);
  if (exists(file)) {
    const record = recordAt(file, uid);
    assert.ok(record.source === source, "E_RECORD_SOURCE");
    assert.ok(record.archive === archive, "E_RECORD_ARCHIVE");
    return inspect(record, uid);
  }
  const sourceParent = directory(path.dirname(source), uid);
  const archiveParent = directory(path.dirname(archive), uid, true);
  const sourceStat = directory(source, uid);
  assert.ok(sourceStat.dev === archiveParent.dev, "E_CROSS_DEVICE");
  assert.ok(!exists(archive), "E_UNRECORDED_CONTAINER");
  const members = inventory(source, uid);
  closed(source);
  fs.mkdirSync(archive, { mode: 0o700 });
  fs.chownSync(archive, uid, Number(sourceStat.gid));
  /** @type {ArchiveRecord} */
  const record = {
    version: 1,
    ownerUid: uid,
    source,
    archive,
    sourceParent: identity(sourceParent),
    archiveParent: identity(archiveParent),
    container: identity(directory(archive, uid, true)),
    directory: identity(sourceStat),
    members,
  };
  saveRecord(file, record, uid, Number(sourceStat.gid));
  syncDirectory(path.dirname(archive));
  return inspect(record, uid);
}
function main() {
  const { values, positionals } = parseArgs({
    options: {
      source: { type: "string" },
      archive: { type: "string" },
      record: { type: "string" },
      "owner-uid": { type: "string" },
      quiesced: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help === true) {
    console.log(
      "Usage: node scripts/archive-retired-history.mjs prepare --source /canonical/agent/history-index --archive /private/archives/unique-container --record /private/records/unique.json --owner-uid UID --quiesced\n       node scripts/archive-retired-history.mjs inspect --record /private/records/unique.json --owner-uid UID\n       node scripts/archive-retired-history.mjs archive --record /private/records/unique.json --owner-uid UID --quiesced\n\nOffline-only opt-in maintenance on Linux/macOS. Run with administrative lsof visibility. --quiesced acknowledges owner-approved stopped/disabled launchers, services, readers and writers; it is NOT an exclusivity check. Read docs/retired-history-maintenance.md first. No startup/install integration, deletion, SQLite open/recovery, or cross-filesystem copy. An interrupted or ambiguous attempt retains its record and both paths for inspection. Archiving reclaims no file allocations.",
    );
    return;
  }
  assert.ok(positionals.length === 1, "E_ACTION");
  const action = positionals[0];
  assert.ok(["prepare", "inspect", "archive"].includes(action), "E_ACTION");
  assert.ok(["linux", "darwin"].includes(process.platform), "E_PLATFORM");
  assert.ok(process.geteuid !== undefined, "E_PLATFORM");
  assert.ok(process.geteuid() === 0, "E_PRIVILEGE");
  if (process.platform === "linux") {
    const capability = /^CapEff:\s*([a-f0-9]+)$/im.exec(
      fs.readFileSync("/proc/self/status", "utf8"),
    );
    assert.ok(capability !== null, "E_PROCESS_VISIBILITY");
    assert.ok((BigInt(`0x${capability[1]}`) & (1n << 19n)) !== 0n, "E_PROCESS_VISIBILITY");
  }
  assert.match(values["owner-uid"] ?? "", /^(?:0|[1-9][0-9]*)$/, "E_OWNER_UID");
  const uid = Number(values["owner-uid"]);
  assert.ok(Number.isSafeInteger(uid) && uid <= 4_294_967_294, "E_OWNER_UID");
  if (action !== "inspect") {
    assert.ok(values.quiesced === true, "E_QUIESCENCE_ACK");
  }
  const file = absolute(values.record);
  if (action === "prepare") {
    console.log(
      `${prepare(values, uid)}: inventory recorded; nothing deleted and no file allocations reclaimed.`,
    );
    return;
  }
  assert.ok((values.source ?? values.archive) === undefined, "E_RECORD_ONLY");
  const record = recordAt(file, uid);
  let state = inspect(record, uid);
  if (action === "archive" && state === "prepared") {
    assert.ok(!exists(path.join(record.archive, "history-index")), "E_DESTINATION_APPEARED");
    fs.renameSync(record.source, path.join(record.archive, "history-index"));
    syncDirectory(path.dirname(record.source));
    syncDirectory(record.archive);
    state = inspect(record, uid);
  }
  console.log(
    `${state}: verified physical state; nothing deleted and no file allocations reclaimed.`,
  );
}
try {
  main();
} catch (error) {
  let code = "E_INSPECTION_FAILED";
  if (error instanceof assert.AssertionError && !error.generatedMessage) {
    const firstLine = error.message.split("\n")[0];
    if (/^E_[A-Z_]+$/.test(firstLine)) {
      code = firstLine;
    }
  }
  console.error(
    `[retired-history] ${code}\nStop. Preserve the external record and both locations; do not delete, merge or retry blindly. See the maintenance guide. Private paths, contents and inspector output are not printed.`,
  );
  process.exitCode = 1;
}
