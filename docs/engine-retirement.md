# Execution coverage after foreground-engine retirement

All launches use the public executor, `runAsyncPath`, and the detached owner. Waiting is a view over that owner. There is no separate synchronous execution engine or test replacement for one.

The removed modules are `execution`, `chain-execution`, `run-single-path`, `run-parallel-path`, `run-chain-path`, and `timeout-extension` under `src/runs/foreground`. Their private launch, notification, receipt, detachment, formatting, and artifact-write helpers are retired too. `recordRun` remains owner-used. `saveForegroundRun`, `ForegroundResumeRun`, `foregroundRuns`, `compactForegroundResult`, and legacy `foreground.json` reads remain for persisted-run migration.

## Behavior-to-test map

Paths in this table are under `test/integration` unless another directory is named. Existing owner coverage is retained rather than duplicated for each deleted engine.

| Contract formerly exercised through the foreground engines | Current execution evidence |
| --- | --- |
| Long/task-named agents, separate prompt files, long tasks, JSON `null` output | `single-execution.test.ts`: actual executor launches and recorded child arguments. Artifact basenames are bounded so long profile names cannot prevent result publication. |
| Bridge permissions, inherited/custom extensions, effective child cwd, fallback skill lookup | `single-execution.test.ts`: child environment, extension arguments, real cwd and resolved skills. |
| Fanout routing, inherited resources and depth tightening | `single-execution.test.ts`, `chain-execution.test.ts`, and retained `fork-context-execution.test.ts` router cases. |
| Exhausted fallbacks, per-attempt output baselines, ordinary failure without retry, successful same-model recovery, prior failure diagnostics | `single-execution.test.ts` and retained `async-execution.test.ts` cases. Empty recovery failures retain the earlier diagnostic. |
| Timeout without fallback, extension without a deadline, extensions surviving recovery, completed siblings and partial output | `single-execution.test.ts`, `parallel-execution.test.ts`, and `owned-result-retention.test.ts`. Controls go through the executor rather than removed callback registries. |
| Assistant token/time limits; fresh per-review allowance | `async-execution.test.ts`, `result-contracts.test.ts`, and `shared-child-attempt.test.ts`. The native per-attempt time case exceeds one allowance overall while both attempts succeed in the same process. |
| Explicit file-only references, generated-output cleanup, output schemas, full durable output with bounded model projection | Existing `single-execution.test.ts` and `parallel-execution.test.ts` router cases; `owned-result-retention.test.ts`. |
| Sequential/static named outputs and file references passed downstream; group preflight | `chain-execution.test.ts`: actual router calls and downstream child arguments. Invalid file-only groups are rejected before any child starts. |
| Dynamic expansion, ordering, named collections, failed/paused siblings and fail-fast | Retained `async-execution.test.ts` and `result-contracts.test.ts`; native checked acceptance for materialized children in `owned-result-retention.test.ts`. |
| Duplicate/unknown output names, missing/invalid structured output, dynamic file-only rejection | `chain-execution.test.ts` and retained async dynamic-validation cases. |
| Workflow-level expansion/collection errors do not invent failed children | `async-execution.test.ts`, `detached-chain-completion.test.ts`, and `native-tool-results.test.ts`. Real child evidence stays successful; the error and failed group belong to the workflow. |
| UI availability alone does not request a preview | `chain-execution.test.ts`: a UI fixture fails if called without `clarify:true`. |
| Binary worktree patches, cleanup and preservation on capture failure | `owned-result-retention.test.ts`, retained router cases in `parallel-execution.test.ts`, and retained worktree cases in `async-execution.test.ts`. |
| Mutation completion and repeated-tool-failure guards | Retained owner cases in `async-execution.test.ts`. |
| Native Claude CLI, resume/session metadata, structured output and unsupported capabilities | `claude-code-execution.test.ts`: actual executor and saved-run continuation with the existing mock Claude CLI. Includes an explicit model override from a Pi profile. Bridge application happens after each attempt's model is resolved. |
| Same-process native acceptance, stale/current reports, resubmission, retry, shutdown, cancellation, verification and human-only blockers | `shared-child-attempt.test.ts`, `acceptance-report-boundary.test.ts`, `owned-result-retention.test.ts`. The existing real-SDK report fixture now performs initial work and review in one session; it does not simulate the acceptance loop. |
| Cancellation during native review retains its actual rejected outcome and unconfirmed report | `acceptance-report-boundary.test.ts`: the owner replays recorded native turns even when cancellation has already arrived; it starts no additional review or verification. |
| Real bash/descendant stop and truthful process/history evidence | `native-acceptance-cli.test.ts`: router launch plus explicit stop against the real native CLI. `process-lifecycle.test.ts` retains owner cancellation and descendant-cleanup cases. |
| Questions during initial work and self-review release the wait without abandoning acceptance | `owned-result-retention.test.ts`: real `contact_supervisor`, durable question/answer, same child PID and one durable completion. |
| Releasing a wait preserves queued/dependent steps and dynamic validation | `detached-chain-completion.test.ts`, `intercom-result-delivery.test.ts`, and native Intercom/registered-tool fixtures. Assertions use `result.json`, not a new `foreground.json`. |
| Grouped completion delivery, fallback delivery, original evidence and duplicate suppression | `intercom-result-delivery.test.ts`: actual router publication consumed by the production result watcher. Retained watcher tests cover notification boundary details. |
| Acceptance survives timeout, failed self-review, child death and saved-session revival | Migrated native cases in `intercom-result-delivery.test.ts`. |
| Live native streaming and attention | `native-streaming.test.ts` and the owner branches of `pi-intercom-native-replay.test.ts`. |
| Artifact trust boundary | `test/unit/temp-paths.test.ts`: a symlinked configured root is rejected by `getArtifactPaths`, the boundary used by the current launcher. Refusal happens before a write. |
| Registered tools, saved native results and native card rendering | `native-tool-results.test.ts` and `test/fixtures/native-tool-results.mjs`: actual SDK registration, agent loop, tool-result hooks, persistence and TUI event composition. |

## Updated lifecycle expectations

Releasing a wait neither interrupts the owner nor skips queued or dependent work. A released call retains its immutable wait receipt; later inspection reads the owner's completed evidence. Explicit interrupt still stops work and retains completed siblings.

Native self-review requires a current, complete typed answer and acceptance report. A report-only response without the required answer is rejected, with prior output retained as unconfirmed audit evidence. Native retry, resubmission and review stay within the same process; tests no longer equate a review turn with a second CLI launch.

Workflow failure and child failure are separate. A rejected dynamic collection retains the real child results and reports a failed workflow/group without creating a fictitious child.

## Local verification

Use the repository's isolated runners: `npm run test:unit` and `npm run test:integration`. Type and packaging gates are `npm run typecheck`, `npm run build`, `npm run smoke:package`, and `npm run smoke:install`. Native fixtures use controlled local providers and forbid network requests.
