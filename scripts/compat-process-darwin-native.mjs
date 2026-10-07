import koffi from "koffi";

const proc = koffi.load("/usr/lib/libproc.dylib");
const system = koffi.load("/usr/lib/libSystem.B.dylib");
const pidinfo = proc.func(
  "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)",
);
const listpids = proc.func(
  "int proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int buffersize)",
);
const getsid = system.func("int getsid(int pid)");
const sysctl = system.func(
  "int sysctl(int *name, unsigned int namelen, void *oldp, size_t *oldlenp, void *newp, size_t newlen)",
);
const kill = system.func("int kill(int pid, int sig)");
const MAX_BYTES = 1024 * 1024;
const OWNER_PREFIX = Buffer.from("PI_COMPAT_PROCESS_OWNERS=");
const DIRECTORY_PREFIX = Buffer.from("PI_COMPAT_GUARDIAN_DIRECTORY=");
const HASH_PREFIX = Buffer.from("PI_COMPAT_BASELINE_HASH=");
const EXECUTABLE_PREFIX_BYTES = Buffer.byteLength("executable_path=");
const utf8 = new TextDecoder("utf-8", { fatal: true });

// Koffi's published callable returns any; native results are unknown until
// validated here. Exact signatures/layouts come from the public Darwin SDK.
/** @param {unknown} value @returns {number} */
function integer(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Invalid native integer result");
  }
  return value;
}
if (integer(koffi.sizeof("size_t")) !== 8) {
  throw new Error("Unsupported Darwin size_t ABI");
}
function checkDeadline(deadline) {
  if (Date.now() >= deadline) {
    throw new Error("Owned-process cleanup observation exceeded its deadline");
  }
}
function identity(pid) {
  // Public sys/proc_info.h: flavor3 proc_bsdinfo is136 bytes, start timeval120.
  // arg1 includes unreaped zombies; their birth/UID remain inspectable.
  const data = Buffer.alloc(136);
  if (integer(pidinfo(pid, 3, 1, data, data.length)) !== data.length) {
    if (integer(kill(pid, 0)) === -1 && integer(koffi.errno()) === 3) {
      return;
    }
    throw new Error(`Cannot establish native identity for PID ${pid}`);
  }
  if (data.readUInt32LE(12) !== pid) {
    throw new Error("Native PID identity mismatch");
  }
  return {
    pid,
    uid: data.readUInt32LE(20),
    exited: data.readUInt32LE(4) === 5,
    pointerSize: (data.readUInt32LE(0) & 0x10) !== 0 ? 8 : 4, // Public PROC_FLAG_LP64.
    pgid: data.readUInt32LE(100),
    sid: integer(getsid(pid)),
    identity: data.subarray(120, 136).toString("base64"),
  };
}
function candidates(pid) {
  if (pid !== undefined) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("Invalid native query PID");
    }
    return [pid];
  }
  const data = processList();
  const pids = [];
  for (let offset = 0; offset < data.length; offset += 4) {
    const candidate = data.readInt32LE(offset);
    if (candidate > 0) {
      pids.push(candidate);
    }
  }
  return [...new Set(pids)];
}
function processList() {
  // Public PROC_UID_ONLY4, not PPID/argv ownership. Reserve slack and reject
  // saturation rather than interpreting a truncated enumeration as absence.
  const needed = integer(listpids(4, process.getuid(), null, 0));
  if (needed <= 0 || needed > MAX_BYTES - 4096) {
    throw new Error("Invalid native process enumeration size");
  }
  const data = Buffer.alloc(needed + 4096);
  const used = integer(listpids(4, process.getuid(), data, data.length));
  if (used < 0 || used >= data.length || used % 4 !== 0) {
    throw new Error("Native process enumeration saturated or failed");
  }
  return data.subarray(0, used);
}
function extent(mib) {
  const length = Buffer.alloc(8);
  if (integer(sysctl(mib, 3, null, length, null, 0)) !== 0) {
    throw new Error("Cannot size native environment");
  }
  const size = length.readBigUInt64LE();
  if (size < 4n || size > BigInt(MAX_BYTES)) {
    throw new Error("Invalid native argument size");
  }
  return Number(size);
}
function environment(pid) {
  const mib = new Int32Array([1, 49, pid]); // CTL_KERN/KERN_PROCARGS2, public SDK.
  const capacity = extent(mib);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(capacity));
  const data = Buffer.alloc(capacity);
  if (integer(sysctl(mib, 3, data, length, null, 0)) !== 0) {
    throw new Error("Cannot read native environment");
  }
  const used = length.readBigUInt64LE();
  if (used < 4n || used > BigInt(capacity) || extent(mib) !== capacity) {
    throw new Error("Native argument extent changed during observation");
  }
  return data.subarray(0, Number(used));
}
function environmentStart(raw, pointerSize) {
  const argc = raw.readInt32LE(0);
  const pathEnd = raw.indexOf(0, 4);
  if (argc < 1 || argc > raw.length || pathEnd < 4) {
    throw new Error("Invalid native argv snapshot");
  }
  // XNU exec_extract_strings aligns the saved executable_path= plus its NUL
  // to the target pointer width. sysctl_procargsx strips that prefix and adds
  // argc's four bytes. Skip ONLY that padding, never an empty argv[0].
  const savedPathBytes = pathEnd - 4 + 1 + EXECUTABLE_PREFIX_BYTES;
  const argvStart =
    4 + Math.ceil(savedPathBytes / pointerSize) * pointerSize - EXECUTABLE_PREFIX_BYTES;
  let offset = argvStart;
  if (offset >= raw.length || raw.subarray(pathEnd + 1, offset).some((byte) => byte !== 0)) {
    throw new Error("Invalid native executable path padding");
  }
  // m = NULs at the decoder's argv start: empty argv slots or an ambiguous zero run.
  let leading = 0;
  while (offset + leading < raw.length && raw[offset + leading] === 0) {
    leading++;
  }
  for (let index = 0; index < argc; index++) {
    const end = raw.indexOf(0, offset);
    if (end < offset) {
      throw new Error("Incomplete native argv snapshot");
    }
    offset = end + 1;
  }
  return { offset, leading, argvStart };
}
function hasPrefix(entry, prefix) {
  return entry.subarray(0, prefix.length).equals(prefix);
}
function tokenAfter(raw, start, tokens) {
  return tokens.some((token) => raw.subarray(start).includes(Buffer.from(token)));
}
function ownsEntry(entry, tokens) {
  if (!hasPrefix(entry, OWNER_PREFIX)) {
    return false;
  }
  const owners = entry.subarray(OWNER_PREFIX.length).toString("latin1").split(",");
  return tokens.some((token) => owners.includes(token));
}
function ownerOutsideEnvironment(raw, start, tokens) {
  // Full-capacity process.title can swallow env slots as argv. Exact NUL-
  // delimited OWNER entries there veto; argv bytes never authorize a signal.
  for (let offset = start; offset < raw.length;) {
    const end = raw.indexOf(0, offset);
    if (end < offset) {
      return false;
    }
    if (ownsEntry(raw.subarray(offset, end), tokens)) {
      return true;
    }
    offset = end + 1;
  }
  return false;
}
function parseEnvironment(raw, start, tokens) {
  let offset = start;
  let owned = false;
  let directory;
  let baselineHash;
  while (offset < raw.length && raw[offset] !== 0) {
    const end = raw.indexOf(0, offset);
    if (end < offset) {
      throw new Error("Incomplete native environment snapshot");
    }
    const entry = raw.subarray(offset, end);
    if (entry.indexOf(61) < 1) {
      throw new Error("Ambiguous native environment boundary");
    }
    owned ||= ownsEntry(entry, tokens);
    if (hasPrefix(entry, DIRECTORY_PREFIX)) {
      if (directory !== undefined) {
        throw new Error("Duplicate native guardian directory");
      }
      directory = utf8.decode(entry.subarray(DIRECTORY_PREFIX.length));
    }
    if (hasPrefix(entry, HASH_PREFIX)) {
      if (baselineHash !== undefined) {
        throw new Error("Duplicate native baseline hash");
      }
      baselineHash = entry.subarray(HASH_PREFIX.length).toString("latin1");
    }
    offset = end + 1;
  }
  return { offset, owned, directory, baselineHash };
}
function parseReceipt(raw, tokens, pointerSize) {
  let start;
  let parsed;
  try {
    start = environmentStart(raw, pointerSize);
    parsed = parseEnvironment(raw, start.offset, tokens);
  } catch (error) {
    // Structural surprises stay fatal when owner bytes exist after argv (or
    // anywhere when argv itself is unparseable); otherwise they are opaque.
    if (
      tokenAfter(raw, start?.offset ?? 4, tokens) ||
      (start && ownerOutsideEnvironment(raw, start.argvStart, tokens))
    ) {
      throw error;
    }
    return { owned: false, complete: false };
  }
  checkOwnerBoundary(raw, start, parsed, tokens);
  // XNU's omit branch copies at most m strings past the decoder's argc
  // boundary. More than m terminated strings plus a real terminator prove
  // completeness; allocated padding outside the returned bytes proves nothing.
  let slots = 0;
  for (let index = start.offset; index < raw.length; index++) {
    slots += raw[index] === 0 ? 1 : 0;
  }
  return {
    ...parsed,
    complete: parsed.offset < raw.length && slots > start.leading,
  };
}
function checkOwnerBoundary(raw, start, parsed, tokens) {
  if (
    tokenAfter(raw, parsed.offset, tokens) ||
    (!parsed.owned && ownerOutsideEnvironment(raw, start.argvStart, tokens))
  ) {
    throw new Error("Receipt outside native environment boundary");
  }
}
function validateStableIdentity(before, after) {
  if (
    after.identity !== before.identity ||
    after.uid !== before.uid ||
    after.sid !== before.sid ||
    after.pointerSize !== before.pointerSize
  ) {
    throw new Error("Unstable native snapshot");
  }
}
function receipt(before, tokens) {
  const none = { processes: [], opaque: [] };
  let raw;
  try {
    raw = environment(before.pid);
  } catch (error) {
    const current = identity(before.pid);
    if (!current || current.exited) {
      return none;
    }
    throw error;
  }
  const after = identity(before.pid);
  if (!after || after.exited) {
    return none;
  }
  validateStableIdentity(before, after);
  const owner = parseReceipt(raw, tokens, before.pointerSize);
  const entry = { pid: before.pid, identity: before.identity };
  return {
    processes: owner.owned
      ? [
          {
            ...entry,
            directory: owner.directory,
            baselineHash: owner.baselineHash,
            complete: owner.complete,
          },
        ]
      : [],
    opaque: owner.complete ? [] : [{ ...entry, sid: before.sid }],
  };
}
export function nativeSnapshot(request) {
  const result = { processes: [], identities: [], opaque: [], uncertainties: [] };
  const tokens = Array.isArray(request.token) ? request.token : [request.token];
  for (const pid of candidates(request.pid)) {
    if (pid === process.pid) {
      continue; // Actual query helper is an observer, never its caller's work.
    }
    checkDeadline(request.deadline);
    let before;
    try {
      before = identity(pid);
      if (!before) {
        continue;
      }
      result.identities.push(before);
      if (!request.identityOnly && before.uid === process.getuid() && !before.exited) {
        const observed = receipt(before, tokens);
        result.processes.push(...observed.processes);
        result.opaque.push(...observed.opaque);
      }
    } catch (error) {
      result.uncertainties.push({ pid, identity: before?.identity, message: error.message });
    }
  }
  return result;
}
