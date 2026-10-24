# Archive the retired SQLite history index

Upgrades to 0.50.0 and later leave the old `history-index` directory untouched.
There is no startup cleanup, deletion prompt, or success marker. Use this manual
maintenance route if you want to archive the retired data. If you cannot establish
the offline conditions below, keep the directory in place.

An archive preserves recovery and rollback. Moving it on the same filesystem
**does not free disk space**. A later purge is a separate, explicitly authorized
operation. This guide does not authorize deletion or change any live installation.

## Establish an offline maintenance boundary

1. Obtain the machine owner's approval for the maintenance window and archive
   location. Inventory every old Pi installation, bridge, launcher, background
   runner, service, and configured agent directory that can access this storage.
   Include 0.48.0 packages that can be launched again, not only the newest bridge.
2. Use an externally enforced maintenance environment in which those applications
   cannot run or relaunch. For example, boot a separate maintenance environment
   with the application volume mounted locally and no application services or
   other clients. Keep this boundary through verification and any rollback.
3. If any writer or reader remains active, or another machine can access the
   volume, stop here. A process listing, an empty `lsof` result, an old modification
   time, a SQLite lock, or a new lock file does not prevent the next old launch.
   Closing visible Pi windows is insufficient. Old detached work can finish later
   and write timing samples.

A successful directory rename does not establish this boundary. Existing handles
can keep writing the moved files, and a relaunched old release can recreate the
original path. Do not use an online `mv` or `rm` command as a substitute for isolation.

## Identify the complete owned recovery set

1. Resolve the agent directory for the retired installation. Its default is
   `~/.pi/agent`, but the old `PI_CODING_AGENT_DIR` can select another directory.
   In a maintenance environment, resolve paths relative to the mounted application
   volume, not the maintenance user's home. Select only its `history-index` child.
2. Verify the canonical parent and directory identity without following symbolic
   links. Inspect every directory member with the filesystem's no-follow metadata
   tools. Stop for a symlink, a hard link, foreign ownership, an unexpected nested
   directory, a special file, or permissions that permit another writer. Compare
   ownership with the retired application's account, not the maintenance shell's
   account. Do not repair these conditions by changing permissions, owners, or file
   contents.
3. Establish provenance from the retired installation and a private inventory.
   Familiar names alone do not establish ownership. The 0.48.0 writer used these
   names:
   - SHA-256 owner manifests named `<64 lowercase hex digits>.json`.
   - UUID generation databases named `<uuid>.sqlite`.
   - Per-generation ingest locks named `<uuid>.sqlite.ingest.sqlite`.
   - The separate timing database `run-timing.sqlite`.
   - SQLite `-wal` and `-shm` companions for those databases.
4. Keep all generations and their companions together, including generations no
   longer selected by a manifest. Stop for unknown names, incomplete sets, temporary
   manifest files, rollback journals, or unexplained contents. Investigate them
   without moving or deleting them. Do not infer that they are disposable.
5. Record the source identity, file identities, sizes, metadata, and byte hashes in
   a private maintenance record outside the selected directory. Record the archive
   destination there too. Treat the inventory and archive as private conversation
   data. Do not upload database contents or file names to an issue or PR.

Do not open the original databases to identify their schemas. SQLite can create
sidecars or recover files when opened. Inspect a complete disposable copy instead.
The historical generation schema uses `user_version=5` and a `meta` table. The
separate timing database uses `timing_meta` and `samples`, not that generation
version. Schema matches corroborate provenance but cannot authenticate it.

Never include native Pi session JSONL files, `run-history.jsonl`, current
`agent-runs` storage, legacy completion inputs, or Intercom storage. Current
Intercom still uses SQLite. This is not a general SQLite cleanup procedure.
Timing samples in the retired database may not exist in another file.

## Archive without a partial file-by-file cleanup

1. Recheck the offline boundary and source identity. Select a private, unique
   archive container on the **same local filesystem**. Ensure its parent is trusted,
   owned, and not a symlink. Reserve the container exclusively and record its
   identity. The `history-index` child inside the container must not exist.
   If a destination already exists, stop and inspect it. Never overwrite it.
2. Use the maintenance environment's filesystem tool to rename the complete
   `history-index` directory into that container in one same-filesystem operation.
   Do not use a tool that falls back to a cross-filesystem copy and delete. Do not
   move individual databases or sidecars. Do not checkpoint or truncate originals.
3. Verify that the original path is absent and the archive has the recorded
   directory identity, members, sizes, ownership, permissions, and byte hashes.
   Account for the directory's expected rename timestamp change. Keep the original
   archived bytes unchanged. Record the observed state, not a blanket success flag.
   A successful rename is not a tested power-loss durability guarantee. Keep the
   maintenance boundary until the archive is verified and durably backed up using
   the storage system's documented procedure.
4. Make a private disposable working copy of the entire archive on a local
   filesystem. Preserve the database basenames and companion relationships. Let a
   compatible SQLite implementation recover that copy, then run `PRAGMA
   integrity_check` and inspect expected committed data. Do not use `immutable=1`
   to bypass WAL recovery. SQLite recovery may change the working copy, which is
   why the retained archive must not be the working copy.
5. Keep the archive for the owner's retention and rollback period. Do not purge it
   as part of an upgrade. To reclaim filesystem capacity later, obtain separate
   deletion approval after a verified off-device backup and the same isolation
   checks. Measure actual filesystem allocation, not just logical file lengths.

No online command is supplied because it cannot enforce the first prerequisite.
The repository test `test/integration/retired-history-maintenance.test.ts` verifies
rename and SQLite recovery mechanics in temporary storage. It is not a maintenance
utility or an automated check of these operator prerequisites.

## Reconcile an interrupted attempt

Inspect both recorded locations before any retry. Do not infer state from the last
line of a maintenance record.

- If the source retains its recorded identity and the archive child is absent,
  the move has not occurred. Recheck every prerequisite before attempting it.
- If the source is absent and the archive has the recorded identity and complete
  inventory, verify the archive. Do not repeat the move. This is also the normal
  rerun case after a completed archive.
- If both exist, neither exists, either identity differs, or any member changed,
  stop. Preserve both trees and the maintenance record for investigation. A
  recreated source may belong to an old release that relaunched. Do not merge
  directories or treat that source as another stale cache.
- If a copy, backup, or SQLite recovery check fails, retain the archive and all
  available evidence. Do not mark cleanup complete or delete the source to hide
  the failure.

For rollback, keep the offline boundary, verify the archive again, and restore the
whole recovery set only when the original path is absent. If an old release has
recreated the path, stop instead of overwriting it. Restoring the cache does not
restore a package version or authorize a live restart.

## Historical ownership evidence

The inspected old release is [0.48.0 at d4caa135](https://github.com/fitchmultz/pi-subagents/tree/d4caa1351c6dbc181276860123b5b00c969de56b).
Its [database owner](https://github.com/fitchmultz/pi-subagents/blob/d4caa1351c6dbc181276860123b5b00c969de56b/src/history/database.ts)
selects the directory and WAL mode. Its
[generation owner](https://github.com/fitchmultz/pi-subagents/blob/d4caa1351c6dbc181276860123b5b00c969de56b/src/history/database-generation.ts)
selects manifests without unlinking another connection's WAL. Its
[store](https://github.com/fitchmultz/pi-subagents/blob/d4caa1351c6dbc181276860123b5b00c969de56b/src/history/store.ts)
opens the ingest companion. Its
[timing owner](https://github.com/fitchmultz/pi-subagents/blob/d4caa1351c6dbc181276860123b5b00c969de56b/src/runs/shared/run-history.ts)
reads and writes the separate timing database.

The old [history worker launcher](https://github.com/fitchmultz/pi-subagents/blob/d4caa1351c6dbc181276860123b5b00c969de56b/src/history/index.ts),
[detached runner launcher](https://github.com/fitchmultz/pi-subagents/blob/d4caa1351c6dbc181276860123b5b00c969de56b/src/runs/background/async-launch.ts),
and [runner timing call](https://github.com/fitchmultz/pi-subagents/blob/d4caa1351c6dbc181276860123b5b00c969de56b/src/runs/background/runner-step.ts)
remain launchable from that release. They do not honor a new maintenance marker.

[Commit 7b721902](https://github.com/fitchmultz/pi-subagents/commit/7b721902fb28c31e15757b3dc3dbe1b42b1a06c9)
removes these owners. At the inspected current-main baseline
`4906e67e3a6701a753df3af112304dea2246aeb1`, production source and install scripts
have no `history-index` or `run-timing.sqlite` reference. The
[retention ledger](https://github.com/fitchmultz/pi-subagents/blob/4906e67e3a6701a753df3af112304dea2246aeb1/docs/test-retention.md) records the retired reader. That establishes
retirement in this source tree, not exclusivity over other installed releases.
