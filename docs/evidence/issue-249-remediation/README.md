# Issue #249: executable-route remediation

This is a new evidence epoch after integration head
`88bff3e027511ea18bdd7ea53d90b845fe5a42f7`, with main
`9bf0f6b21b26fcfb975761c3243b512382aec6d8` already merged normally.
It does not relabel the original measurements or the integration keeper as
measurements of this implementation. Exact file identities are in
`source-hashes.sha256`; hosted qualification is reported at the final PR head.

## Dispositions

1. **Executable, bounded route.** `scripts/archive-retired-history.mjs` is packed
   and opt-in. It implements `prepare`, read-only reconciliation via `inspect`,
   and same-device whole-directory `archive`. An exclusively reserved private
   container and unchanged external record bind native identities, inventory and
   hashes. Prepared/completed retries derive physical state; mixed, replaced,
   incomplete, linked, foreign-owned, unsafe POSIX modes or unexpected state stops. There is
   no deletion, copy/delete fallback, rollback overwrite or startup/install hook.
2. **Practical quiescence, not an exclusion claim.** The guide specifies stopped
   clients and stopped/disabled launch mechanisms, account/host/storage scope,
   administrative handle inspection and an isolated-boot fallback only when
   ordinary controls cannot establish the boundary. The acknowledgment, native
   `lsof`, rename and hashes do not exclude future writers. Linux requires actual
   effective root and `CAP_SYS_PTRACE`; the filesystem root must be owned by UID 0.
3. **Correct affected range.** All 16 public owning tags are **v0.44.0–v0.49.1**;
   first removed is **v0.50.0**, commit
   `7b721902fb28c31e15757b3dc3dbe1b42b1a06c9`. `tag-inventory.tsv` covers all 143
   local public release tags, including unprefixed `0.13.0`, with 126 preceding
   non-owning tags. `affected-tags.tsv` pins the owning commits/source paths.
   This is a source inventory, not runtime qualification of every historical
   release or a claim that v0.44.0 was published to npm. The executed historical
   writer remains the separately identified v0.48.0 sample.
4. **Test the shipped route.** Sixteen native subprocess cases replace standalone
   rename/SQLite demonstrations. They execute the actual script, compare native
   file identity/content observations, and recover only complete disposable
   copies. The separate CLI startup and real SDK deferred-recovery keepers remain.
   Benchmark-shaped suite output, heartbeat assertions and unused override knobs
   were removed. Journals and fixtures are retained rather than unlinked.
5. **Name the actual lifecycle boundaries.** The CLI keeper proves extension load
   through `session_start`, not a deferred scan. The SDK keeper waits for actual
   completion processing and verifies a physical receipt before explicit tools,
   then runs `agent_runs list` and `inspect` and checks uniqueness/preservation.
   `list` alone does not prove `scan()` ran. Native ordinary SDK attachment still
   awaits durable ownership; no generic claim that all attachment occurs later
   is made. The incoming #248 attach/deferred-timer keeper also retains its journal.
6. **Archive is not reclamation.** The guide separates an off-device complete-set
   backup, private identity/hash verification, disposable restored-copy recovery,
   separate authorization for one exact container, and before/after `du`/`df`
   accounting. No purge action is implemented or run. Archive reclaims no original
   database allocations; no installed/private-corpus latency or capacity gain is
   claimed.

## Observed macOS CI publication race

The complete 141,803-byte failed job log from integration head `88bff3e` is retained
as `integration88-macos.log` (run 40103054740, job 120899024676). All five then-current
retired-history cases passed. Its one integration failure was the observation
rewrite keeper: `ObservedChild.gate()` saw the published filename before
`writeFileSync()` supplied complete JSON and raised `Unexpected end of JSON input`.
The compatibility aggregate failed as a consequence, not independently.

The fixture now writes a unique sibling with `wx`, closes the complete write, then
atomically renames it to the gate filename. Consumer parsing, assertions, release
conditions, sleeps and timeouts are unchanged. The affected suite retains native
journals/gate files outside its separate socket-runtime cleanup. The existing
rewrite keeper plus native text/tool gate keepers exercise the changed boundary.

## Local qualification and counterfactuals

- `focused-strict-final.log`: **19 passed, zero skipped**, including the 16 shipped
  command cases, actual bundled CLI startup, native deferred completion/inspect,
  and the incoming native attach/deferred-timer keeper.
- `focused-observation-strict.log`: **3 passed, zero skipped**: rewrite (the observed
  failure), text publication and concurrent-tool publication.
- `red-ancestor-native-root.log`: disconnecting the actual ancestor-validation
  call fails both negative cases because preparation incorrectly succeeds.
- `red-private-native-root.log`: adding raw exception output fails the exact
  sanitized-envelope assertion on native `ELOOP`, exposing a synthetic path.
  Mutants were restored byte-for-byte before green checks; neither is shipped.
- Lint (zero warnings/errors), formatting, TypeScript, unchanged size ceilings,
  build and actual installed-package/native-actor smoke passed. The package smoke
  requires the packed `.mjs` and executes its installed `--help` from both
  production-only package layouts. No TypeScript runtime loader is required.

The outer cloud filesystem root is UID 2346, so the strict production command
correctly refuses a UID-0 fixture there. Final native qualification uses a fresh,
real UID-0 filesystem root in private Linux mount/PID namespaces, with the existing
worktree mounted read-only, real `/proc`, real `lsof`, and a real distinct tmpfs for
cross-device refusal. There are no fake inspectors, production bypass knobs,
root-ownership changes or account/default changes. `native-context.sh` and
`native-roots.tsv` record this test-only environment. Its data is physically under
`/workspace`, outside namespace/device teardown, so final journals survive workspace
rollovers. A rollover removed the earlier OS `lsof` install; the retained
missing-prerequisite run refused safely before the prerequisite was reinstalled.

Earlier exploratory runs/failed authoring logs are retained separately in the
private workspace and do not qualify the final policy. Some intermediate `/tmp`
journal roots did not survive an automatic container rollover; they were not
reconstructed or substituted. Original committed investigation/integration evidence
is unchanged. Final strict-policy journals and all final/red fixture bytes remain
under the recorded workspace roots. The packet contains intentional refusal-case links; extract only into a disposable
private directory, never over live data, and do not reuse its plans. It omits live
Unix socket endpoints, which are not recovery/journal data. The public synthetic
packet excludes generated
empty auth/model stores and compiler caches; none contains owner/private history.

## Test-authoring gate

| Behavior and credible regression                                                                                            | Existing gap and chosen owner                                                                                        | Real observation; no production seam                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Whole recovery-set archive drops a generation/sidecar, reuses a substituted destination, or trusts a mutable success marker | Existing Node-rename examples did not call shipped maintenance; new subprocess route suite owns it                   | Native inode/owner/mode/hash inventory, actual command states, unchanged record and disposable-copy SQL values   |
| Unsafe ancestors or private filesystem/JSON diagnostics are accepted                                                        | New native refusal cases, with two actual command mutants                                                            | Real ownership/permission changes on synthetic paths and exact controlled stderr envelope                        |
| Startup or delayed reconciliation deletes retired data or publishes duplicate receipts                                      | Retain narrow native CLI startup, actual SDK deferred completion plus explicit `inspect`, and incoming attach keeper | Physical journal entry before tools, exactly one receipt after reconciliation, and independent retired inventory |
| Existence of a gate filename exposes an incomplete payload                                                                  | Reuse the published failing native rewrite keeper and existing text/tool keepers, not a new mock suite               | Actual fixture producer and native consumer; complete sibling publication and unchanged parser/assertions        |

The owner-installed `test-audit` skill and the attempted pinned public skill path
were unavailable. The four-question authoring gate was recorded before this work
using a published test-audit reference; this is not claimed as a retrieved pinned
pstack skill. The pinned workflow/AGENTS constraints remain in force. Full
`npm run ci` belongs to fresh hosted official/fork/platform qualification, not a
local substitute. The same approved task/model/defaults and worktree were retained.
