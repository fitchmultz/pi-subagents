# Long-session performance

Version 0.43.1 removes repeated processing that grew with retained runs and native transcript length. Saved sessions, owned results, billing receipts, questions, cancellation, and full on-demand conversations retain their existing contracts.

## Changed behavior

- Background Agents refreshes reuse terminal history projections rather than rebuilding every completed conversation. Only the latest continuation for an assignment loads history and configuration. Conversation cards and full tool details are demand-driven; rendered card caches are limited to the displayed page.
- Unchanged corrupt journals are not reparsed on every refresh. Changed files and transient filesystem failures are retried; boundary errors do not discard valid history indexes.
- Native observations consume verified append-only metadata suffixes. A changed session, replaced source, discontinuous physical suffix, or off-branch append falls back to complete reconciliation. Hosts without the needed optional APIs retain complete reconciliation.
- Child observations are matched through native IDs and ordered role/timestamp/tool-call indexes. Inherited entries are not matched against current-attempt messages. Acceptance polling filters messages only when an actual boundary is ready.
- Nested projection retains all processed event identities while their immutable source files remain replayable. Each job poll reuses one nested projection instead of computing it three times.
- Result polling does not probe delivered and billed run files or repeatedly decode unchanged foreign results. Changed files, canonical results, session identity, and ownership are rechecked. Parent call/billing metadata is indexed incrementally, and accounting reuses the completion check's verified receipt snapshot.

## Regression evidence

The original defects were reproduced with synthetic, isolated data against actual extension functions, without reading personal transcripts or using model inference. Node 24.21.0 and fork Pi 0.99.1 were used for diagnosis.

| Original processing | Reproduction |
| --- | --- |
| Completed conversation rebuilding | 100 retained 2,000-entry child histories, five unchanged refreshes: 1,000,000 timestamp parses and approximately 980 ms. |
| Continuation ancestry recursion | 1,000 continuations representing one visible task: 500,500 identity resolutions per refresh. |
| Native observation scanning | 4,000 appended entries: 8,006,000 metadata visits. |
| Native message matching | 4,000 new messages: 16,004,000 observation predicate checks. |
| Acceptance boundary polling | 4,000 messages: 16,008,000 filtering predicate checks. |
| Nested deduplication expiry | 4,000 retained event files: 3,000 old files reread on every unchanged projection. |
| Foreign result polling | 40 unchanged foreign files: 120 decodes across three scans. |
| Delivered result probes | 10,000 delivered/billed runs: 30,003 existence checks across three scans. |

A same-host recheck on the exact maintained fork (`76dfe3d1`, Node 24.21.0) compared the previous source with 0.43.1:

| Synthetic operation | Before | After |
| --- | --- | --- |
| 100 completed 2,000-entry histories, five refreshes | 1,000,000 timestamp parses; 1,005 ms | 0 timestamp parses; 1.6 ms |
| 1,000 continuations, one visible task | 500,500 identity resolutions | 1,000 |
| 10,000 delivered/billed runs, three polls | 30,003 existence checks | 3 directory checks |
| 40 unchanged foreign files, three polls | 120 decodes | 40 initial decodes |
| 20,000 parent entries, ten owner checks | 400,020 visits, 20 scans | 40,002 visits, two startup scans |
| 1,500 retained nested events, unchanged poll | 500 event rereads and one registry rewrite | Neither |
| Nested projection in one job poll | Three registry reads | One |
| Ten 100-card history windows | 1,001 cached components | 101, including the assignment |

Cold factory startup did not measurably change: five isolated offline CLI launches ranged from 410–605 ms before and 411–437 ms after. The minimum difference was below run-to-run variation. These repairs target growing history/recovery and steady-state processing, not the host's constant extension-loading cost.

Primary regression owners are `test/integration/agent-interaction.test.ts`, `test/integration/shared-child-attempt.test.ts`, `test/integration/result-watcher.test.ts`, and `test/unit/{journal-reader,nested-events,subagent-prompt-runtime}.test.ts`. Native completion/usage/reopen/checkpoint tests protect the authority and recovery contracts independently.

Run the repository's [local validation](../README.md#local-validation) against an explicitly selected host. Operation counts are more repeatable than timing thresholds; the timings above describe these synthetic inputs, not a promised latency improvement for every user's session.

## Necessary costs and limits

Cold recovery must enumerate owned records and validate relevant published source data. Receipt integrity verification still reads existing parent-journal bytes: a file-size or timestamp cache alone cannot prove that a receipt was not rewritten. Sharing verified snapshots removes duplicate verification inside a completion/accounting operation; it does not weaken byte verification or equate accepted/queued messages with durable delivery.

Native history append reuse must validate its existing prefix before parsing only appended records. Explicit full message/details requests still need that individual record to fit the consumer's heap. Nested directories and their processed-ID sidecars grow linearly while immutable events remain retained; an atomic archival checkpoint is the upgrade path if a route's lifetime outgrows that representation.

Official Pi 0.99.2 eagerly loads native session bodies during its own startup. Extension changes cannot remove that host cost. Optional metadata APIs on the maintained fork support incremental extension indexes; unsupported hosts retain the safe full-scan path.

These regressions establish concrete extension defects and their repairs, not proof that every source of interactive latency has been eliminated. Provider inference, context size, native host persistence/rendering, and other extensions remain separate costs.
