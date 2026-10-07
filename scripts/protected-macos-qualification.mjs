import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUEST_PATH } from "./protected-macos-guest-bootstrap.mjs";
import { execute } from "./protected-macos-transport.mjs";
import { saveState, writeReceipt } from "./protected-macos-operator.mjs";
import { qualifyGuard } from "./protected-macos-guard-qualification.mjs";

function sourceInputs(source) {
  assert.match(source.commit, /^[a-f0-9]{40}$/);
  assert.match(source.tree, /^[a-f0-9]{40}$/);
  assert.equal(execute("git", ["rev-parse", `${source.commit}^{tree}`]).trim(), source.tree);
  const entries = execute("git", ["ls-tree", "-r", "-z", source.commit])
    .split("\0")
    .filter(Boolean);
  return entries.map((entry) => {
    const separator = entry.indexOf("\t");
    const [mode, type, oid] = entry.slice(0, separator).split(" ");
    assert.equal(type, "blob", "Qualification does not admit Git submodules");
    assert.ok(["100644", "100755", "120000"].includes(mode));
    const path = entry.slice(separator + 1);
    return {
      path,
      mode,
      sha256: createHash("sha256")
        .update(execute("git", ["cat-file", "blob", oid], { encoding: null }))
        .digest("hex"),
    };
  });
}
function verifySource(guest, source) {
  const expected = sourceInputs(source);
  const actual = JSON.parse(
    guest.ci({
      command: `export PATH=${GUEST_PATH}; cd /Users/ci/source; node --input-type=module`,
      input: `
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
const entries = ${JSON.stringify(expected)};
const actual = entries.map(({ path }) => {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() || stat.isSymbolicLink(), "Tracked input must be file or symlink");
  const mode = stat.isSymbolicLink() ? "120000" : (stat.mode & 0o111) !== 0 ? "100755" : "100644";
  const bytes = stat.isSymbolicLink() ? readlinkSync(path, { encoding: "buffer" }) : readFileSync(path);
  return { path, mode, sha256: createHash("sha256").update(bytes).digest("hex") };
});
console.log(JSON.stringify(actual));
`,
    }),
  );
  assert.deepEqual(
    actual,
    expected,
    "Qualification must run the independently frozen source inputs",
  );
  return {
    source,
    verifiedInputs: actual.length,
    inventoryHash: createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
  };
}
function keeper(guest, state, enclosed) {
  const command = enclosed
    ? `node --input-type=module -e 'import {run} from "./scripts/compat-process.mjs"; await run(process.execPath,["--test","test/quality/compat-process.test.mjs"],{timeout:300000,stdio:"inherit"});'`
    : "node --test test/quality/compat-process.test.mjs";
  const log = guest.ci({
    command: `export PATH=${GUEST_PATH}; cd /Users/ci/source; ${command}`,
    timeout: 300000,
  });
  const path = join(state.root, `${state.bootstrap}.${enclosed ? "enclosed" : "standalone"}.log`);
  writeFileSync(path, log, { mode: 0o600 });
  assert.match(log, /(?:ℹ |# )fail 0/);
  return { log, exit: 0 };
}
function absent(guest, logs) {
  const rows = logs.flatMap((log) =>
    [...log.matchAll(/Native (?:fixture|NO-WORK) absence: (\{[^\n]*\})/g)].map((match) =>
      JSON.parse(match[1]),
    ),
  );
  assert.ok(rows.length > 0, "Real native keeper publications required");
  const program = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const koffi = require("koffi");
const info = koffi.load("/usr/lib/libproc.dylib")
  .func("int proc_pidinfo(int pid,int flavor,uint64_t arg,void *buffer,int size)");
const kill = koffi.load("/usr/lib/libSystem.B.dylib").func("int kill(int pid,int sig)");
const rows = ${JSON.stringify(rows)};
const unique = [...new Map(rows.map(row => [row.pid + ":" + row.identity, row])).values()];
for (const row of unique) {
  assert.equal(row.uid, process.getuid());
  const bytes = info(row.pid, 3, 1, Buffer.alloc(136), 136);
  assert.equal(kill(row.pid, 0), -1);
  assert.equal(koffi.errno(), 3);
  assert.notEqual(bytes, 136);
}
console.log(JSON.stringify({
  distinctIncarnations: unique.length,
  allESRCH: true,
  pidReuse: false,
  nonzeroSignals: 0
}));
`;
  return JSON.parse(
    guest.ci({
      command: `export PATH=${GUEST_PATH}; cd /Users/ci/source; node --input-type=module`,
      input: program,
    }),
  );
}
export async function qualify(state, path, guest) {
  assert.equal(state.active, null);
  const source = JSON.parse(readFileSync(state.qualification, "utf8")).source;
  if (guest.status() === "stopped") {
    await guest.start();
  } else {
    await guest.connect();
  }
  guest.installObserver();
  if (state.preQualificationCut) {
    guest.quiescence();
  }
  guest.warm();
  const cut = guest.cut();
  saveState(path, { ...state, preQualificationCut: cut, qualificationPhase: "running" });
  const inputs = verifySource(guest, source);
  const privilege = guest.security();
  const network = await guest.network();
  const native = guest.native();
  const nativeGuard = await qualifyGuard(guest, state);
  const standalone = keeper(guest, state, false);
  const enclosed = keeper(guest, state, true);
  const absence = absent(guest, [standalone.log, enclosed.log]);
  // Exercise the same CI login used for settlement diagnostics, after real work.
  guest.ci("/usr/bin/git --version; /usr/bin/true");
  const quiet = guest.quiescence();
  assert.deepEqual(
    [quiet.bootSeconds, quiet.bootMicroseconds],
    [cut.bootSeconds, cut.bootMicroseconds],
  );
  const receipt = {
    source,
    inputs,
    native,
    nativeGuard,
    privilege,
    network,
    preQualificationCut: cut,
    quiet,
    standaloneExit: standalone.exit,
    enclosedExit: enclosed.exit,
    absence,
  };
  const qualification = join(state.root, `${state.owner}.qualification-current.json`);
  writeFileSync(qualification, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  writeReceipt(state, "qualification", receipt);
  saveState(path, {
    ...state,
    qualification,
    preQualificationCut: cut,
    qualificationPhase: "completed",
  });
  return receipt;
}
