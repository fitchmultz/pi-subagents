# Archive the retired SQLite history index

Public tagged releases **v0.44.0 through v0.49.1** can open `history-index`.
**v0.50.0** first carries removal commit
[`7b721902`](https://github.com/fitchmultz/pi-subagents/commit/7b721902fb28c31e15757b3dc3dbe1b42b1a06c9).
Upgrades leave that directory untouched. There is no startup cleanup, deletion
prompt, or success marker. An older installation can still reopen or recreate it.

The packaged `scripts/archive-retired-history.mjs` command is an **opt-in,
offline-only archive route**, never an extension startup or installation hook.
It preserves the whole recovery set; it never deletes, opens a database through
SQLite, checkpoints originals, or copies across filesystems. A same-filesystem
archive **reclaims zero file allocations**. A later purge needs separate approval.
This guide is not permission to inspect or change a live installation.

## Establish the maintenance boundary

1. Obtain the machine owner's approval for the exact storage, archive location
   and maintenance window. Inventory every installation from the affected range,
   bridge, launcher, detached runner, service, scheduler and other client that can
   access the volume, including packages that can be launched again.
2. Stop **all readers and writers** and disable their launch/relaunch paths for
   the entire window, verification and any rollback. Include old detached timing
   writers and other machines or namespaces that can reach the storage. Keep
   another operator from starting maintenance against the same paths.
3. Establish that boundary through the owner's actual service/launcher controls.
   A separately booted OS is not mandatory. If stopped/disabled applications and
   access controls cannot establish quiescence, use an isolated maintenance
   environment, for example a separate boot with the application volume mounted
   locally and no application services or other clients. Otherwise stop untouched.

The command's `--quiesced` flag acknowledges these conditions; it cannot enforce
or verify them. Privileged native `lsof` checks detect observable open handles,
not a stopped program's next launch, another client, or an inaccessible namespace.
Root visibility is necessary, not a universal completeness guarantee. A rename,
one empty `lsof` result, a SQLite lock, a new marker or unchanged hashes do not
prove exclusion. Rechecks detect some changes but do **not** remove all races.
Privileged or same-account interference remains outside the enforced boundary.
Do not use the command if that boundary is uncertain.

## Select and validate the owned set

Resolve the retired installation's agent directory. Its default was `~/.pi/agent`;
`PI_CODING_AGENT_DIR` could select another. In a separate maintenance environment,
use the mounted application account's paths, not the maintenance user's home.
Select **only** its `history-index` child, never the agent directory itself.

Establish provenance from the retired installation and the owner's private
inventory. Familiar names and schema matches do not authenticate ownership.
The command accepts only these historical flat-file names:

- SHA-256 owner manifests: `<64 lowercase hex digits>.json`.
- UUID generation databases: `<uuid>.sqlite`, including unselected generations.
- Ingest databases: `<uuid>.sqlite.ingest.sqlite`.
- Timing database: `run-timing.sqlite`.
- Matching SQLite `-wal` and `-shm` companions.

A manifest must select an included generation. An ingest database must have its
generation; sidecars must have their database and a complete WAL/SHM pair.
Missing/unexplained companions require investigation, not automatic repair.
Unknown entries, temporary manifests, rollback journals, nested directories,
special files, symbolic/hard links, foreign UID or writable-to-others state stop
the command. It never fixes owners or permissions on the original set. Canonical
paths must have no symbolic-link components. The filesystem root itself must be
owned by administrative UID 0. Every other ancestor must be controlled by root
or the retired account and not writable to unrelated accounts; the sole
writable-ancestor exception is a root-owned sticky directory such as `/tmp`,
whose selected child must still have trusted ownership. Private leaf directories
under an unsafe ancestor are not sufficient. Audit ACLs and mount/user-ID mappings
as well: POSIX mode checks do not certify those. Extra write grants to other
principals are unsupported; stop unless you can exclude them before invocation.

**Exclude all native Pi JSONL files, `run-history.jsonl`, current `agent-runs`,
legacy completion inputs and Intercom storage.** Current Intercom still owns
SQLite. Timing samples may not be reconstructible from another file. Do not open
original databases to identify schemas: SQLite can recover or create sidecars.
Inspect and recover a complete disposable copy instead.

## Run the packaged route

The command supports Linux and macOS with Node at the package's supported floor.
It requires administrative native `lsof` visibility. Linux needs `/usr/bin/lsof`
and effective `CAP_SYS_PTRACE` for cross-account process inspection; root inside
a restricted container is not sufficient. macOS uses `/usr/sbin/lsof`. Missing
tools, warnings, incomplete inspection, interruption or unexpected results stop
the command. There is no unprivileged,
forced or best-effort bypass. This optional command does not change the extension's
host support or require `lsof` during normal runtime/install.

Use a reviewed, trusted package and Node executable when running with privilege.
Run from outside the selected source/container so your shell is not an open
reader of the directory. Create private record and archive **parents** under trusted ancestors, owned by
the retired account, before invoking the command. Use normalized canonical paths
without trailing slashes. Select a new, unique container name and external record
file, both outside the recovery set; the record must also be outside the archive
container. Keep the record and all command results private. Do not upload caches,
record contents, names, paths or hashes to issues or PRs.

The following placeholders must be replaced locally after owner approval. These
are commands for the authorized maintenance window, not ordinary upgrade steps:

```sh
# Set explicit canonical paths and the retired account's numeric UID.
NODE=/absolute/trusted/path/to/node
SCRIPT=/absolute/trusted/package/scripts/archive-retired-history.mjs
SOURCE=/canonical/agent/history-index
CONTAINER=/private/archive-parent/unique-container
RECORD=/private/record-parent/unique-inventory.json
OWNER_UID=1234

# Phase 1: inspect, reserve the container exclusively, and write the external plan.
sudo "$NODE" "$SCRIPT" prepare --source "$SOURCE" --archive "$CONTAINER" \
  --record "$RECORD" --owner-uid "$OWNER_UID" --quiesced

# Read-only reconciliation before the move or any retry.
sudo "$NODE" "$SCRIPT" inspect --record "$RECORD" --owner-uid "$OWNER_UID"

# Phase 2: recheck the plan and handles, then rename the complete directory once.
sudo "$NODE" "$SCRIPT" archive --record "$RECORD" \
  --owner-uid "$OWNER_UID" --quiesced
```

`prepare` creates a new `0700` container with exclusive `mkdir` and an external
`0600` record with exclusive no-follow creation. It records source, parent and
container identities plus every member's device/inode, ownership, mode, link
count, size, modification/change timestamps and SHA-256. Raw hash reads can update
access time; they do not recover SQLite or change file contents. All generations
and available companions stay together. The command does not alter the record afterward; it is not
OS-enforced immutable storage and is **not** a cleanup-success marker. An
interruption before record publication can leave an unrecorded empty container;
stop and investigate rather than adopt or remove it automatically.

`archive` checks the real state, identities, entire inventory and open handles
again. It uses a native same-filesystem directory rename, with **no** copy/delete
fallback. The exclusively reserved private container must have no unexpected
contents or existing destination. This is not an atomic no-clobber guarantee
against a competing root/same-account process; the enforced quiescent boundary
remains mandatory. After the move, the command checks the archive against the
record. Any failure preserves the observed locations and record for investigation;
it does not roll back automatically, merge trees, or conceal ambiguity. Directory
and record sync calls do not establish a tested power-loss durability guarantee.

Public failure output is a controlled refusal ID, not a dump of paths, hashes,
JSON or `lsof` output. `E_OPEN_HANDLES` means a reader/writer is still observable;
`E_LSOF_*` means inspection could not be accepted. `E_PROCESS_VISIBILITY` means
Linux cannot establish the required administrative inspection capability. `E_UNKNOWN_MEMBER`,
`E_MEMBER_TYPE`, `E_FOREIGN_OWNER`, `E_UNSAFE_MODE` and `E_ANCESTOR_*` require
provenance/path investigation. `E_CROSS_DEVICE` prohibits the move.
`E_INVENTORY_CHANGED`, identity-change IDs and `E_AMBIGUOUS_PATHS` mean stop and
preserve both trees. `E_INSPECTION_FAILED` covers other filesystem/JSON failures;
inspect the private inputs locally rather than posting their contents.

## Reconcile interruption and rerun

Run `inspect` against the **same external record** before retrying. Do not infer
state from a prior console line or create a replacement record to bypass drift.

- Source has the recorded directory/inventory; archive child is absent and its
  reserved container is unchanged: **prepared**, no move yet. Re-establish all
  prerequisites before `archive`. Repeating matching `prepare` also inspects it.
- Source is absent; the archive child has the recorded identity/inventory:
  **archived**. Repeating `archive` verifies this state without moving anything.
- Both or neither paths exist, an identity/member changed, the record is unsafe,
  or an unrecorded destination already exists: **stop**. Preserve both trees and
  the record. A recreated source can belong to a relaunched old release; do not
  merge it, overwrite either location, or call it another stale cache.

Under the same offline boundary, recover **only a complete disposable copy** of
the archive with a compatible SQLite implementation. Run `PRAGMA integrity_check`
and inspect expected committed data on that copy. Do not use `immutable=1` to
bypass WAL recovery. Recovery can change its copy; retained archive bytes must
still match the external record. Historical generation schema `user_version=5`
and `meta`, and timing tables `timing_meta`/`samples`, corroborate format only.

For rollback, keep quiescence, verify the complete recorded archive again, and
restore the whole recovery set **only when the original path is absent**. Never
overwrite a recreated source or restore individual sidecars. Restoring the data
does not restore a package version or authorize restarting a live application.

## Later space reclamation: a separate owner decision

The archive command never purges and never reports disk cleanup completed.
A successful same-filesystem move frees no file allocations and can consume
additional metadata space. Do not purge as part of an upgrade or this procedure.

1. Keep the verified archive for the owner's retention/rollback period. Obtain
   approval for a private, encrypted **off-device** backup destination. Record its
   physical device/storage identity, not just another directory or partition on
   the source disk. Use the storage system's documented durable backup procedure
   to copy the **whole container**, preserving basenames/companions, and retain
   the external inventory separately. Do not recover the retained archive.
2. Test a restore into a new, exclusively reserved private **disposable** directory.
   Compare the exact flat member-name set, file sizes and per-file SHA-256 against
   `members` in the external JSON record; reject extra files, links or missing
   members. Native `sha256sum -c` on Linux or `shasum -a 256 -c` on macOS can check
   a private checksum list made from each `sha256` and `name`. A checksum pass
   alone does not detect extra members, so compare the name set separately.
   Recover that complete restored copy and check integrity/expected committed
   contents. Record the verified backup object identity/checksum and successful
   restore checks. Merely copying a file or seeing it on another volume is not
   backup verification.
3. Ask the owner for a **new purge authorization** naming only the recorded
   canonical archive container, its filesystem/volume identity, device/inode,
   owner/mode, the external record's checksum and the verified backup identity.
   Explicitly exclude the original `history-index` path, all journals/current
   state, other archives, the external record and the backup. Approval for the
   earlier archive or backup is not purge approval.
4. During a separately enforced maintenance window, run the command's `inspect`
   again. Compare the actual container, parents and members with the original
   record, and corroborate the source-volume identity with the OS storage tool.
   Reject symlink/mount substitutions, new source data or any ambiguity. The
   separately approved purge tool/operator must recheck that **exact container**
   immediately before deletion and must not follow links, cross mounts, expand a
   wildcard or fall back to deleting the original path. This archive-only command
   intentionally supplies no purge action or original-path deletion command.
5. Record allocation **before** that authorized purge using `du -sk` on the exact
   container and `df -k` on its trusted parent. These report allocated KiB and
   filesystem capacity, not logical database lengths. After the authorized tool
   has removed only that container, verify that identity is gone, the backup and
   excluded paths remain, and repeat `df -k` on the same filesystem. Preserve the
   records. Snapshots, clones, compression, open handles, background writes and
   delayed filesystem reclamation can make free-space changes differ from `du`;
   report actual observations rather than claiming the archive size was freed.

No backup, purge, real-data inspection, install or restart is run by repository
verification. Synthetic command tests exercise these archive/retry guards and
recover disposable copies; they do not certify operator quiescence, private-data
provenance, off-device durability or permission to purge.

## Historical source inventory

All 16 public tags from v0.44.0 through v0.49.1 retain generation, ingest and timing
owners. The earliest tagged owner is
[`v0.44.0` at `4f288484`](https://github.com/fitchmultz/pi-subagents/tree/4f288484d98488286fe137604c45ed49ac6b995d):
[database](https://github.com/fitchmultz/pi-subagents/blob/4f288484d98488286fe137604c45ed49ac6b995d/src/history/database.ts#L6-L28),
[manifest/generation/ingest store](https://github.com/fitchmultz/pi-subagents/blob/4f288484d98488286fe137604c45ed49ac6b995d/src/history/store.ts#L43-L78),
and [timing writer](https://github.com/fitchmultz/pi-subagents/blob/4f288484d98488286fe137604c45ed49ac6b995d/src/runs/shared/run-history.ts#L58-L80).
The last is
[`v0.49.1` at `f757ed05`](https://github.com/fitchmultz/pi-subagents/tree/f757ed054e7d819fd590a3da346be8a03aefe2d4):
[generation](https://github.com/fitchmultz/pi-subagents/blob/f757ed054e7d819fd590a3da346be8a03aefe2d4/src/history/database-generation.ts#L52-L80),
[ingest](https://github.com/fitchmultz/pi-subagents/blob/f757ed054e7d819fd590a3da346be8a03aefe2d4/src/history/store.ts#L275-L299),
[detached timing writer](https://github.com/fitchmultz/pi-subagents/blob/f757ed054e7d819fd590a3da346be8a03aefe2d4/src/runs/background/runner-step.ts#L143-L149),
and [history worker](https://github.com/fitchmultz/pi-subagents/blob/f757ed054e7d819fd590a3da346be8a03aefe2d4/src/history/index.ts#L112-L127).
These old owners do not honor a new maintenance marker.

The earlier execution sample remains specifically **v0.48.0 at
`d4caa1351c6dbc181276860123b5b00c969de56b`**, not a runtime test of all releases.
The maintained main baseline for this source candidate is
`64f7e91d278006622dd2d7f12fc81271a1caffb2`;
its runtime/startup/install paths have no retired history owner. The original
measurements remain bound to admitted baseline `4906e67e3a6701a753df3af112304dea2246aeb1`
and original PR head, not relabeled as measurements after integration.
