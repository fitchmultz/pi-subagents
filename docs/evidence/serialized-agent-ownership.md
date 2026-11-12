# Serialized agent ownership qualification

## Native contract

`src/agent/ownership-lock.ts` holds a SQLite `BEGIN EXCLUSIVE` transaction on a
persistent private `ownership.lock` file. Attachment admission locks the owner
directory. Actor launch locks the conversation directory, outside `actor.lock`,
after the asynchronous stopping/cancellation checks and before reinspection.
The ownership transaction remains held through dead-claim removal, acquisition, native spawn,
and process-record publication, including native spawn errors.

The file is created mode 0600 and validated as a regular file owned by the current
user. It is never removed. Only the creator opens and closes a raw file descriptor;
subsequent acquisitions leave descriptor management to SQLite.

No busy handler, timeout override, retry loop, lease, or stale-lock reclamation is
installed. Native contention is an explicit refusal. Closing the connection releases
the transaction; process exit releases the OS lock.

## Dependency proof

Qualified locally on Node v24.22.3, Darwin arm64, SQLite 3.54.1. The package's Node
floor remains unchanged at 24.21.0. No npm dependency or lockfile changed.

- Node's [SQLite API](https://github.com/nodejs/node/blob/v24.22.3/doc/api/sqlite.md#new-databasesyncpath-options)
  documents `DatabaseSync` since 22.5.0 and the native default busy timeout of zero
  (`doc/api/sqlite.md:123-128,180-182`).
- [Node's close implementation](https://github.com/nodejs/node/blob/v24.22.3/src/node_sqlite.cc#L1547-L1558)
  finalizes statements, deletes sessions, and invokes `sqlite3_close_v2` before
  clearing the connection. This lock creates no statements, sessions, or backups.
- [SQLite close](https://sqlite.org/c3ref/close.html) automatically rolls back an
  open transaction when the connection is destroyed.
- [SQLite transactions](https://sqlite.org/lang_transaction.html#deferred_immediate_and_exclusive_transactions)
  acquire the write transaction immediately for `BEGIN EXCLUSIVE`; a competing
  writer receives `SQLITE_BUSY`.
- [SQLite locking requirements](https://sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_)
  explain why closing an unrelated raw descriptor can cancel POSIX locks. The
  primitive does not open such a descriptor for an existing lock inode.

## Regression boundary

`test/integration/agent-ownership.test.ts` uses separate real main processes and
Node's native debugger to schedule the reported overlap. Filesystem, liveness,
SQLite, and spawn operations are not replaced.

Both admission and reclaim cases fail on stack6 baseline
`3a0afe07b24f7bf6738c29a6b0e537c1892db8a3`: the second process succeeds while the first
is paused after its absent-owner read or successful inode comparison.
With serialization, the second process is refused at those same boundaries.
The reclaim keeper also pauses after native spawn but before PID publication and
verifies exclusion still holds. After release, the second main observes the same
one live runner rather than spawning another.

The keeper additionally exercises a real `ENOENT` spawn failure, same-process and
cross-process contention, ordinary close, process death while holding a lock, and
stable private inode preservation. Real runners stop at Node's debugger entry,
before SDK/provider work; these tests prove launch ownership, not provider output.
Each case stops its owned mains and runner groups and removes its isolated root.

Linux/Android and separate official/fork runtime graphs remain qualification for
the parent-owned hosted gates. The full test suites are not run locally.
