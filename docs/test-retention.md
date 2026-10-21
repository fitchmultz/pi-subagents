# Rebuild test retention ledger

Baseline: `1646ab895e25fb56847ad669733c55807bc8ff3c`. This is a change-specific
ledger, not permission to delete every old test. The safety inventory and required
boundaries are summarized in [the rebuild gates](single-agent-rebuild.md).

## Explicitly retired remote surfaces

The user authorized rebuilding the Grok companion and retiring remote
launch/control/catalog/group/transcript APIs. Their old CLI, HTTP routes and local
control-envelope owner are removed, not emulated through plain messages.

| Removed test owner / exact case                                                                                                                                                       | Detected failure / disposition                                                                      | Remaining required owner                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intercom-native-control.test.ts`: native capabilities/transcript use no inference or transcript cache                                                                                | Retired authenticated remote capabilities/transcript route; no production caller remains.           | New local `last` uses separate frames; native replay keeper covers actual response paging/no wake. It is not a general remote transcript API.                                          |
| Same suite: private allowlist revocation, certificate expiry and display-name spoof are denied before effects                                                                         | Retired remote cancel/stop control authorization; `native-control-auth` and control frames removed. | Retained bridge suites continue certificate-derived identity, revocation, TLS, and ordinary mail authorization. No remote process-control route remains.                               |
| Same suite: unified foreign stop and incorrect response correlation cannot confirm execution                                                                                          | Retired remote stop/capability protocol.                                                            | Native child `agent_runs stop` process-identity proof remains separately required; messaging correlation is retained in bridge/native reply keepers.                                   |
| Same suite: native current-operation abort reaches a real tool signal and preserves pending input                                                                                     | Remote abort endpoint retired; not evidence that child Stop can be discarded.                       | New native child lifecycle must prove actual abort/accepted work behavior before old core retirement.                                                                                  |
| Same suite: native stop acknowledges a request, invokes host shutdown, and never claims process exit                                                                                  | Remote native shutdown route retired.                                                               | Broker survives helper shutdown in retained `intercom-bridge.test.ts`; native actor Stop retains distinct process outcome evidence.                                                    |
| Same suite: explicit/dynamic groups are private, deduplicated, restart-persistent and return partial receipts; broadcast preserves receipts and unknown outcomes on broker stall/kill | Remote persisted groups/fanout retired; orphan `intercom-fanout-broker.ts` removed.                 | Ordinary single-send UNKNOWN outcomes remain in bridge delivery tests. New main/child topology is separately enforced by broker/native tests, not the old group registry.              |
| `intercom-transcript.test.ts`: recent native transcript follows only the active branch, pages and bounds UTF-8 textual output                                                         | General multi-role transcript API retired.                                                          | Native local last-response keeper covers active-branch assistant text, stable full Unicode paging and no wake. New paging is UTF-16, not the retired UTF-8 transcript cursor contract. |
| Same suite: approved saved journal transcript is projected and migration is in-memory, never a read rewrite                                                                           | Retired remote saved-session transcript reader and approval catalog.                                | Required native journal LF/torn-tail/ownership recovery remains an independent core gate; do not treat this retirement as deletion permission for those tests.                         |
| Same suite: native transcript scan ceiling is explicit and does not offer an unusable cursor                                                                                          | Retired bounded transcript endpoint scan policy.                                                    | No replacement API promises this scan ceiling.                                                                                                                                         |

These tests originated with the now-removed remote lifecycle/group implementation.
The associated production owners had no callers outside that protocol (except its
own tests and the broker's now-removed control-envelope type). Removing the owners
and envelope field prevents hidden control effects through the remaining mail
surface. Validation is the retained native local keeper plus bridge transport,
mailbox, auth and wake suites—not a source assertion that the old names vanished.

## Local intercom retirement

The local UI, topic registry, child-only supervisor tool, role prompts, structured
interviews, and durable supervisor-question revival are explicitly retired.
Ordinary request/reply is weaker than durable saved-answer revival and is
documented as such. Native incoming message checkpoint, queue, compaction,
reload, cold-crash and generation ownership remain required.

`pi-intercom-native-replay.test.ts` retains actual SDK/provider/socket/journal
proof. The completed local transfer qualified 56 native/broker tests on official
Pi 1.3.0 and fork revision `997a2575…`, plus 27 sibling unit cases. The six distinct
broker-process cases remain in `pi-intercom-runtime.test.ts`; the exact old-case
dispositions are in [intercom-test-retention.md](intercom-test-retention.md).
These are lane results; final integrated qualification is recorded separately.

## Bridge cancellation and downstream ownership

The shared-broker survival assertion was transferred from the retired launch
suite into `intercom-bridge.test.ts`. Its independent peer remains usable after
helper shutdown.

The retained mutation-cancellation test observes a real admitted HTTP send while
a real broker is stopped, then aborts the request. It checks generation retirement,
stable certificate-bound identity on re-registration, and discarded volatile
inbox accounting. Read-only inbox cancellation tests are not its replacement.

Companion tests exercise `(profile, message ID)` receipt and wake ownership at
actual mTLS/worker/CLI/filesystem boundaries, including restart and historical
unscoped receipts. The previous ID-only terminal suppression regression was
reproduced against old code. Consumer fsync precedes server ACK; the companion
then owns the reply duty. No test claims an ACK alone is completed work.

## Core boundary keepers

The replacement uses the selected real SDK, actual OS processes, native journals,
real filesystem publication and public runtime disposal. It does not simulate
settlement by returning a fabricated child result. The original boundary inventory
was checked against the replacement before retiring mixed suites.

| Preserved boundary / old owner                                                                                             | New keeper and independent assertion                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-async-host`, `native-result-routing`, owned portions of `result-watcher`                                           | `single-agent-runtime`: native receipt precedes held child completion; orderly exit and SIGKILL before/after actual append recover once in a fresh process; foreign and forked owners cannot adopt. Old mutable result-Intercom relay and watcher implementation are retired.                                                                                                                                    |
| `native-completion-ownership`: sole legacy input                                                                           | `single-agent-runtime` legacy SIGKILL/reopen/recreated hint cases: no canonical storage or invented ownership; raw hint survives admission and retires only after actual native publication.                                                                                                                                                                                                                     |
| Historical completion receipt matrix and physical parent authority from `session-resume-cost` / `storage-owner-boundaries` | `agent-receipts`: absent/current/foreign owner, old Intercom receipt, successful whole/single-zero wait versus failed/pending/launch-only/wrong-index calls; LF, same-size/stamp edit, prefix growth, inode replacement, shrink, malformed append/recovery with stale native memory.                                                                                                                             |
| Child billing and portable parent usage                                                                                    | Retained/adapted `native-usage`, `parent-usage`, `journal-reader`; native `single-agent-runtime` usage and delayed-LF cases. Physical paid, abandoned and terminal IDs remain separate; checkpoints and inherited work are excluded; required/optional receipts, duplicate/conflicting/empty IDs, exact optional counters, discarded intents, concurrent finalized waits, inspect and cold reader are exercised. |
| Large native journals                                                                                                      | `journal-reader` retains a >512 MiB individual ignored value under a 96 MiB heap, strict UTF-8/LF, literal IDs/counters, selected full body, frozen terminal before malformed successor, bounded completion receipt lookup and unchanged source hash. Old SQLite history-index calls are retired, not described as equivalent APIs.                                                                              |
| Runtime shutdown and foreground cancellation from `native-extension-shutdown` / `owned-run-wait`                           | `single-agent-runtime` uses actual runtime disposal joining admitted filesystem work and settling admitted waits without stopping their producer. Cancelling new foreground delegation or continuation requests Stop; cancelling an observer does not.                                                                                                                                                           |
| Frozen continuation and output immutability from `output-revival`, `native-same-cwd-resume`, `native-run-ownership`        | `single-agent-runtime` saved-native, continuation and repaired-startup cases preserve native conversation/model/thinking/cwd, predecessor bytes and durable claims; missing/foreign/multistep/non-native/live producers refuse before launch. `agent-saved-inputs` independently rejects relative/non-jsonl paths and malformed launch/header metadata before adoption.                                          |
| Directory owner behavior from `native-execution-cwd`, `native-cwd-delegation`, execution-cwd units                         | Actual directory-owner protocol exercises parent A→B, fork C, child change to D and cold continuation at D through relative read/bash; incompatible owner refuses before provider dispatch. Separate qualification loads the real `pi-change-working-dir` owner. Parent journal and child header stay unchanged.                                                                                                 |
| Stop/process ownership from `orphan-stop`, `process-lifecycle`, `native-acceptance-cli`                                    | Native actor/main SIGKILL cases, actual shell-family heartbeats, durable PID/birth/token ledger, mismatched identity and independent bystander; generation-safe escalation and known/unknown exit remain distinct. `agent-process` adds EPERM fail-closed at the actor claim/signal boundary. `close-grace-timer` remains at the shared process/stdio owner.                                                     |
| Native finalized tool result from `native-tool-results`                                                                    | Controlled failure compares the real `tool_execution_end` error/content/details with the finalized native tool result and reopened journal. `native-editor-receipts` separately retains actual editor error/partial-publication/filesystem receipts; removed completion-guard policy is not reconstructed.                                                                                                       |
| Post-spawn ambiguity from `async-execution` / `owned-run-wait`                                                             | Actual main filesystem publication EIO after spawn leaves the original actor and canonical launch discoverable; original and follow-up prompts execute once, same native conversation, immutable predecessor bytes. A repaired startup cannot replay a superseded unadmitted command.                                                                                                                            |
| Private state / path boundaries from old atomic-json, run-status, async-resume, supervisor metadata units                  | `atomic-json` now exercises the real new storage owner: 0600 bytes, traversal/separator rejection, native Unicode metadata values with snapshot-sized reads and 64 KiB ceiling. `temp-paths` retains scope/root resolution. `agent-receipts` rejects symlinked legacy root/results before outside deletion.                                                                                                      |

`pi-coding-agent-dir` retains dynamic environment and tilde expansion at the shared
runtime path owner. Profile discovery, skill injection, config/history and artifact
cleanup assertions in that old mixed suite are explicitly retired.

The old `INTERCOM_DETACH_REQUEST_EVENT` handshake has no remaining caller: the
workflow UI/result relay that emitted it is removed. Its event names, listener
counts and acknowledgement shape are retired, not claimed equivalent to native
AbortSignal cancellation or runtime disposal. Ordinary incoming messaging and
its lifecycle remain in the native Intercom keeper.

Old `appendUsage` contribution-format reconciliation belonged to old completed-run
retrieval. That retrieval is retired; saved single-native continuation excludes
the entire inherited baseline. Modern `agentUsage` tests are not represented as
proof of that removed old receipt format. Durable supervisor-question revival,
multichild selection, nested billing, workflow acceptance and generated output
policies are also retired explicitly.

The misleadingly named old **unit** `intercom-bridge.test.ts` tested canned
supervisor prompt injection, profile tool/extension allowlists and alias helpers
in `src/intercom/`; it was not the authenticated HTTP bridge. That unit owner is
retired. Actual bridge auth, mail, ACK, wake and process suites remain intact.

[Retired feature tests](retired-feature-tests.md) lists complete feature-only
suites. Additional old unit wrappers for fork/context/recursion/identity,
execution modes and cursor internals are replaced at the native boundaries above;
old CLI argument shapes, scan-count optimizations and canned prompt bytes are not
requirements of the new runtime.
