# Issue 249 integration after PR 252

## Scope and identities

This is new integration verification, not a new before/after performance run.
Main advanced to `9bf0f6b21b26fcfb975761c3243b512382aec6d8` when PR 252 merged.
That change moves retained-completion scanning off the awaited attach path.
The existing PR branch incorporated main through a normal merge, without a
rebase or force push.

The original issue-249 head is `8535f09247640e349b4c3eb76b0d276f5a3fc0ec`, tree
`0b1c62343d84dc58387b4c48ff1d3f7861f1c71f`, with original baseline
`4906e67e3a6701a753df3af112304dea2246aeb1`. The entire
[original evidence directory](../issue-249/README.md) remains byte-for-byte
unchanged, Git tree `b5cfbdc6205bbb5c4a5d13cb89af3be72928104c`.
Its five alternating pairs, archive allocations, original-writer experiment,
negative control and filesystem trace retain those original identities. They
are not measurements on the new main. The old test SHA-256 remains
`08aea7fea6f3483f50d7479ede66ab78607bd5af7912923807ad9a9b2274163f`.

The combined `docs/reference.md` and `docs/performance.md` were inspected and
preserved as merged from main. They distinguish durable attachment from later
completion recovery, describe the 200 ms interval as not a delivery deadline,
and retain the source and environment limits of PR 252's measurements.
The manual archive guide neither depends on synchronous completion recovery nor
includes current agent-runs, native journals, legacy completion inputs or Intercom
storage in its recovery set. No documentation conflict required a rewrite.

Relative to the integrated main, production source, dependencies, the lockfile,
support floors and optional peers remain unchanged by this PR. The combined
production source aggregate, computed with
`git ls-files src | sort | xargs sha256sum | sha256sum`, is
`bc3f67056e03f3581dd2e7ff844f1c3691e0c6c8479c4ad6678aca36c056a85b`.
It differs from the historical aggregate because main changed the attach owner.

## Invalidated proof and new keeper

The original actual-CLI observer shuts down at `session_start`. It still checks
startup preservation, but no longer covers a deferred background scanner pass.
That boundary required new proof. The archive rename, SQLite recovery, active
handle and old-writer mechanics did not change; their local five-pair experiment
and separate trace were not repeated merely to attach a new base identity.
Hosted full CI still runs every keeper on the new head.

The additional case in `retired-history-maintenance.test.ts` uses the existing
real SDK fixture and an isolated native SessionManager journal. One saved
completed run belongs to that actual native owner. Before any explicit tool
reconciliation, the test waits for a real background completion receipt and
verifies that it reached the physical native journal. It then executes the real
`agent_runs list` and `inspect` tools, verifies receipt uniqueness, and checks the
retired directory again. Both boundaries preserve all 16 file/link members,
including committed WAL recovery sets, unknown contents, links to an outside
synthetic journal and an open SQLite writer. The outside journal is unchanged;
the active database remains writable afterward.

The test's readiness condition is publication, not a sleep. Expected IDs, counts
and preserved inventory are independent fixture values. Native SDK dispatch,
physical journals, SQLite and filesystem operations are not mocked. Cleanup uses
Node's native AsyncDisposableStack in LIFO order: shutdown/dispose the SDK, close
the database, restore the environment, then dispose only synthetic fixture data.
The evidence option retains those synthetic roots instead of deleting them.

An independent same-model read-only review caught that `list` returns before
explicit reconciliation. The keeper was corrected to invoke `inspect`, which
traverses the scan path. The follow-up review found no remaining actionable
finding. It is not model-diverse review or minimum-Node execution qualification.
The initial lint errors (prefer-const and SessionEntry narrowing) are retained in
[lint-initial.log](lint-initial.log); the final gates pass without rule changes,
casts, suppressed assertions, production exports or test-only injection.

## Commands and local results

Run from `/workspace/issue-249` on Debian Linux x64 with Node `v24.22.1`, npm
`11.19.1` and the existing committed-lockfile official Pi `1.4.0` graph.
[Host identity](host.json) and [package output](package.log) identify the actual
SDK and manifest-selected bundled CLI; the latter's SHA-256 is
`e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774`.
No local fork qualification is claimed. Current-head hosted qualification must
separately establish the official and maintained-fork/platform results.

```sh
npm run lint
npm run format:check
npm run typecheck
npm run check:size
PI_RETIRED_HISTORY_EVIDENCE_DIR=/workspace/issue-249-evidence/integration-252/retained-fixtures \
  node --test --test-name-pattern='actual selected-host CLI|native deferred completion' \
  test/integration/retired-history-maintenance.test.ts
node --test test/integration/agent-attachment.test.ts
npm run build
npm run smoke:package
```

All commands passed. The [focused archive run](focused-archive.log) passed both
selected cases, and the [merged attach keeper](focused-attach.log) passed its
case; both runs had zero failures and skips. Lint, formatting, TypeScript, size,
build and runtime-only package/native smokes passed. Full `npm run ci` is left to
hosted CI as repository policy requires. No source or tests were edited while
checks ran. The new archive keeper SHA-256 is
`02c51754be1b76f4b60b09dbe145e86f21bd7267ebee80a0eeb18166ecbe1c8e`.

[Raw retained synthetic fixtures](synthetic-fixtures.tar.gz) include CLI output,
the observer, the native completion journal and the temporary SQLite data. These
are public-safe generated fixtures, not owner caches or private conversations.
The durations in test logs are runner diagnostics, not new latency benchmarks.
There is no new disk-reclaim, private-corpus or installed macOS latency claim.

The original coordinator-verified `openai/gpt-6.1-sol/xhigh` configuration evidence
remains unchanged. No live data, installed runtime, owner account, provider or
global setting was accessed or changed. No live cleanup, restart, publication,
deployment, merge-to-main or auto-merge was authorized. The PR remains open for
Mitch and coordinator acceptance; fresh hosted checks and enabled reviews belong
to the eventual exact integration head, not to the historical readiness report.
