# Long-session performance

## Current behavior

Native journals and canonical run/control/receipt files remain the sources of truth. SQLite supplies private browse observations, not a new execution owner, completion receipt, billing authority or transcript format. Installing the extension does not adopt unrelated archives or remove provider and queue waits.

Startup recovers saved ownership, unanswered questions and Intercom receipts in small batches, allowing input between batches. Queued Intercom delivery also yields between batches, preserving followers before the final wake-up and staging new arrivals durably until the batch finishes. Retention cleanup uses asynchronous filesystem operations. Tools capture their invocation directory before awaiting restoration, and coordination publishes the current session name even if it changes during recovery. Checkpoint reconciliation remains synchronous and strict. Recovery still checks the complete eligible history and legacy records, without increasing or suppressing the host's performance-warning budget. A single recovery record, native append/projection or integrity scan remains atomic.

### Indexed browsing and lazy Agents work

- A separate Node process incrementally indexes only the current saved parent's admitted runs and linked native sources. A fresh session with no owned work starts no history process or database until it browses. No directory-wide transcript backfill runs at startup.
- List filters and attention/newest/oldest ordering apply globally before a bounded page. Ordinary tool lists return 20 runs by default, at most 100; the Agents picker loads 50 runs and searches full assignments, not just shortened labels. Latest-assignment queries retain unsuperseded siblings while hiding older continuation attempts. Native branch configuration reuses at most 128 compact results across rows and queries, keyed by physical source generation, committed cursor, observed stamp and exact terminal/time/leaf boundary. Publication (including backdated records), replacement and reset invalidate reuse; null leaves and strict missing/cyclic-boundary errors retain their original meaning.
- The parent UI does not scan child journals on startup, ticks, filtering or pagination. Only an opened conversation loads a 100-physical-record page; components are retained for that page. Full details and contextual Reply validate selected native byte references off-thread, including paired tool results outside the current page. Explicit navigation supersedes older requests; background refreshes are coalesced and retain the settled display rather than briefly adding loading rows. Reopening the picker restores its visible filter and page.
- Catch-up, degraded sources, loading, no matches and unavailable history are distinct states. F5 explicitly retries. Drafts, reading anchors, unread boundaries and pins survive same-parent reopen; a changed owner or abandoned overlay cannot accept late results.
- Search indexes saved visible text, not thinking, tool arguments, image payloads, hidden custom data or provider fields. Terminal sequences are removed incrementally before tokenization, including sequences split across read/parser chunks. Its grammar is lexical words or one quoted phrase. Unquoted words must all occur in the same native record, across any of its visible fields/windows; quoted phrases must remain contiguous in one field. Each record contributes one excerpt per matching child attempt. Filters and attempt terminal/time boundaries apply before ranking/paging. Run/child/agent scopes restrict linked physical sources before match aggregation without changing global relevance scores. Each scoped source is scanned once, even when many continuation attempts share it; terminal/time boundaries and attempt attribution still apply before ranking/paging in the final join. Common terms still scan global FTS postings, and global searches may require broad matching and sorting: a small result page is not a constant-work guarantee. Deadlines and cancellation stop the owned history process, which can reopen and replay committed index progress.
- Browse freshness is never authoritative. Selected controls recheck canonical owner facts before acting. Human-message delivery and a later nonempty assistant reply are separate observations. Receipt integrity and native accounting safeguards remain unchanged.

### Storage, budgets and recovery

History projections use the built-in `node:sqlite` binding, qualified at SQLite **3.53.4** with Node **24.21.0**, WAL and `synchronous=FULL`. Other binding versions fail explicitly rather than fall back to synchronous journal queries. Databases live in a private local-filesystem `history-index` directory; symlinked databases/directories are rejected. Each owner selects a disposable generation through its manifest. Corrupt browse generations are replaced without renaming/unlinking an open SQLite database or rewriting native sources; old generations remain private for diagnosis.

Incremental ingestion has one writer per database generation, coordinated by a SQLite transaction in a separate private `.ingest.sqlite` database. The lock spans staging and publication but never locks the browse database between pump steps. Competing workers keep serving queries and retry without busy-spinning. Process exit releases the lock through SQLite; the next writer discards unpublished staging and resumes at the committed cursor, without PID leases, time-based lock stealing or unlinking open databases. Schema upgrades rebuild older derived indexes, including apparently current indexes affected by lost staging in schema 4.

A published source cursor and its indexed entries commit together, and publication must actually update the staged entry before advancing the cursor. LF framing controls publication independently of malformed-record tolerance. Replacement, truncation, deletion and prefix changes invalidate observations. Ingestion scans bytes in bounded chunks and limits assembled previews to 64 levels, 16,384 nodes, 4,096 array positions and 512-character keys. Over-budget records are explicitly degraded, not silently converted into trustworthy evidence; later complete records still index. Selected full native records and canonical saved output have a **16 MiB** detail budget. Concurrent output growth cannot expand a selected read beyond its validated snapshot.

Best-effort timeout samples use a separate `run-timing.sqlite` metadata database. Writer transactions serialize import, insertion and per-agent retention of the latest **1,000** samples. Read-only indexed queries never rotate storage. The old `run-history.jsonl` remains untouched; reads and the first actual writer's import use at most the latest **1 MiB** of complete LF records. This replaces the unlocked reader-side rotation that could erase concurrent writes or another agent's samples. It is a metadata migration, not a canonical run-state migration; older legacy samples remain on disk outside the estimation window.

### Regression proof

The changed boundaries are exercised through real extension functions and registered SDK tools with synthetic isolated data, not personal transcripts or provider inference:

- 20 and 227 genuinely owned runs beside 8,000 unrelated records: Agents startup does no parent-thread child transcript reads or global question listing; only the selected conversation is formatted.
- Native extension startup beside 2,048 foreign owner directories services input during discovery and restores only the current parent's saved runs and unanswered questions.
- Native Intercom reload restores all 1,024 historical receipts while servicing input. Cleared-queue recovery also services input before its 100 followers finish appending, retaining each message once and one final wake-up across an in-flight reload or a cleared busy handoff. New results and explicit steers are staged before acknowledgement and handed to native steering for the next tool boundary; ordinary queued and passive arrivals wait.
- 125 owned assignments: global filtering finds an item beyond the first two picker pages; all later pages remain reachable without UI-thread source access.
- 65 retained runs: off-page reads/stats and migration scans are zero while displayed controls, questions, review and continuation identities remain fresh.
- Warm indexed list/search queries perform no source checks, opens or canonical projections. Cold ingestion and explicit refresh still do necessary verification off-thread. Fifty genuinely admitted live rows sharing an 80,004-entry native journal retain correct state, model, thinking and bounded history through the real worker's unchanged three-second deadline under a 96 MiB JavaScript heap; completed terminal branches remain correct. An unchanged 1,000-run native census keeps projecting all handles but emits only settled freshness, while canonical changes and source failure/recovery still notify. This removes redundant notifications, not the census or UI polling.
- A 512 MiB discarded native field preserves exact eligible usage/IDs/configuration/history, with unchanged source bytes, under a **96 MiB** heap limit. Structural over-budget image/deep/key records degrade explicitly while later visible text remains searchable.
- Completed-attempt search cannot return a successor's later text from a shared physical source. Full selected details reject missing/replaced/truncated sources; canonical output reads reject concurrent growth beyond their snapshot.
- Competing history processes preserve staged configuration/text on normal completion and recover after a writer is killed. Schema-4 indexes with intact cursors but missing entries rebuild from unchanged journals.
- Search covers ANSI-colored words, multi-chunk control sequences, distant terms in a single record, separate visible fields, phrase boundaries and record-level pagination. Picker reopen/clear retains a visible filter; delayed idle refreshes leave dock height unchanged.
- Four independent timing writers preserve each completed sample, another agent's samples, per-agent retained row counts and database integrity. A legacy snapshot read cannot erase an acknowledged write.
- Native tool loading covers list/history/search validation, owned paging and same-parent reload on both compact and advanced routes. UI regressions cover narrow/wide native layouts, full reports/Reply, loading navigation, saved anchors and disposal.

Primary owners are `test/integration/{history-index,owned-run-list,agent-interaction,tool-activation,lazy-coordination,session-resume-cost}.test.ts` and `test/unit/{run-history,journal-reader,temp-root-cleanup}.test.ts`. Run the [local validation](../README.md#local-validation) against an explicitly selected coherent host graph. Operation counts are more repeatable than timing thresholds.

## Receipt and loadout work

A completion-recovery batch shares one SHA-verified parent receipt snapshot only within its synchronous stack. Parent append/count/leaf changes refresh that snapshot, and it is discarded before any awaited delivery resumes. Receipt identities are indexed once per snapshot; unchanged hits do not each hash the whole journal. The eight-hit regression beside a 1,051,980-byte parent reads at most three journal lengths (initial parse/hash, then verification per yielded batch), instead of verification per hit. Awaited delivery rechecks external journal changes even when the in-memory count and leaf are unchanged. SHA, LF publication, replacement/truncation and same-stamp-edit guards remain mandatory.

Native default-active declarations keep advanced orchestration and Intercom lazy without startup deactivation. A small initial-SDK-resume fallback restores this package's declared tools because official 1.0 does not restore its saved loadout during creation. Native tree/reload selection remains authoritative, and activation only adds available owned tools, never excluded ones.

The Agents dock polls while live work, questions, selected/pinned conversations or delivery outboxes need observation. Visited terminal rows reuse their observed metadata until their run changes; full completed history loads on selection. With 50 visited rows (49 terminal), two unchanged refreshes query only the live row; pinned, selected, question, outbox and changed terminal metadata remain observable. The 20/227-terminal-row fixtures also prove three idle ticks request no parent redraw. These are bounded-work optimizations, not archive-size or provider-latency guarantees.

## Historical 0.43.1 baseline

The earlier 0.43.1 fixes removed repeated completed-history projections, continuation recursion, native observation matching, nested polling, and result/receipt polling. Their same-host recheck on fork `76dfe3d1` (Node 24.21.0) remains useful historical evidence; it is not a measurement of the new SQLite browse implementation:

| Synthetic operation | Before 0.43.1 | 0.43.1 |
| --- | --- | --- |
| 100 completed 2,000-entry histories, five refreshes | 1,000,000 timestamp parses; 1,005 ms | 0 timestamp parses; 1.6 ms |
| 1,000 continuations, one visible task | 500,500 identity resolutions | 1,000 |
| 10,000 delivered/billed runs, three polls | 30,003 existence checks | 3 directory checks |
| 40 unchanged foreign files, three polls | 120 decodes | 40 initial decodes |
| 20,000 parent entries, ten owner checks | 400,020 visits, 20 scans | 40,002 visits, two startup scans |
| 1,500 retained nested events, unchanged poll | 500 event rereads and one registry rewrite | Neither |
| Nested projection in one job poll | Three registry reads | One |
| Ten 100-card history windows | 1,001 cached components | 101, including the assignment |

Cold factory startup did not measurably change in that comparison: five isolated offline CLI launches ranged from 410–605 ms before and 411–437 ms after. The minimum difference was below run-to-run variation.

## Necessary costs and limits

Cold recovery still enumerates genuine owner handles and verifies relevant published bytes. Mutable native prefixes require integrity validation before appended suffix reuse; stat-only caches or unchecked SQL negative receipt lookups cannot replace that safeguard. Selected controls and canonical receipt/accounting reconciliation remain separate from browsing.

Pi 1.0 still eagerly loads native session bodies at its own startup; extension installation alone cannot remove that host cost. Explicit fork context still copies and publishes each sibling, with required fsync. An explicit full individual record must fit its detail budget and the consumer's heap.

Full-archive backfill/capacity, sustained contention, power-loss durability and cross-platform performance are not qualified by these macOS/APFS synthetic regressions. No journal deletion, live archive migration, installed-runtime activation or inference request is part of this work. Intentional tool/queue boundaries, provider response time, host rendering and other extensions remain separate possible costs.

## Cached-input traffic and delegation

This section supersedes the investigation in [PR #112](https://github.com/fitchmultz/pi-subagents/pull/112), which inspected `29903ad` before Pi 1.0 modernization. The architecture below was checked against released `4f288484` (0.44.0). No private session journals, invoices or provider requests were inspected. It explains possible traffic, not the cause of a particular account's usage or its dollar cost.

### What grows the provider input

- **Fresh is the default.** A fresh child starts without the parent's conversation. Project context, skills and the child's system prompt can still add substantial input. Explicit `context` overrides the profile; the bundled oracle alone defaults to `fork`. Inspect effective profiles and user/project overrides rather than assuming installed defaults.
- **Fork is a branch, not a summary.** `src/shared/fork-context.ts` creates a separate native branched session per child index. The child uses inherited conversation context plus its new task, subject to Pi's native context/compaction rules and child filtering. Fork failure is explicit, not a fallback to the parent's file.
- **Each child is a separate CLI tool loop.** Pi-backed children use `pi --mode json -p`; Claude-backed children use `claude -p`. Later model turns can send a large stable input prefix again. The extension does not implement provider prompt caching.
- **Async work can overlap.** The root defaults to async, so the parent can continue making requests while children run. A fork is a launch-time snapshot; later parent turns do not update an already-running child.
- **Filtering can change cache sharing.** Child context filtering removes parent-only orchestration messages and tool history where applicable. Native prompt fixtures prove unchanged-history prefix preservation and a changed prefix after filtering; neither is a guarantee that a provider will reuse a cache. A changed prefix does not establish that the entire context must be cache-written.
- **Results can enlarge later input.** Inline results, chain substitutions, completion messages and supervisor notices add parent/next-child text. Some notices or deliveries can trigger a parent turn. Parallel completion is grouped; terminal async completion-guard notices leave the automatic wakeup to their matching result.
- **Fanout is not a daily budget.** Top-level `tasks` uses `parallel.maxTasks` (default 8) after repeat expansion, with default concurrency 4. Static chain `parallel`/`count` is not covered by that top-level size limit. Dynamic fanout requires `expand.maxItems` or `config.chain.dynamicFanout.maxItems`; the per-step limit takes precedence. Bundled profiles disallow nested delegation; explicit opt-in remains depth-bounded. Successful sequential launches are not subject to a daily launch quota.

Sources: `src/runs/{foreground/run-async-path,foreground/execution-input,shared/child-attempt,shared/subagent-prompt-runtime}.ts`, `src/shared/agent-context-policy.ts`, `agents/oracle.md`, and `test/fixtures/native-prompt-sections.mjs`.

### Arithmetic, not attribution

For a hypothetical constant **500,000 cached tokens per request**:

```text
4.26 billion cache-read tokens / 500,000 = 8,520 requests
11.2 million output tokens / 8,520       = 1,314.55 output tokens/request
```

If "97% hit" means cached tokens divided by cached plus uncached input tokens, the corresponding uncached input is `4.26 billion × 0.03 / 0.97 = 131.75 million`, or about `15,463.92` per request. A request-based hit percentage would not support that calculation.

| Hypothetical steady workload | Cache-read tokens |
| --- | ---: |
| One 500k-prefix session, one request/10 seconds for 24 hours | 4.32 billion |
| Parent plus eight 500k-prefix children, one request/30 seconds each for 8 hours | 4.32 billion |
| Eight 50k-prefix fresh children, one request/30 seconds each for 8 hours | 384 million |

These assumptions include sustained activity and a full cache hit on that prefix; they are not measured workloads, throughput guarantees or pricing estimates. Token counts alone cannot establish dollars, double billing, a spawn loop, or which sessions made the requests.

### Accounting and useful checks

`src/runs/shared/native-usage.ts` excludes inherited launch-baseline entries and nonbillable checkpoints, then validates and deduplicates new native contributions. Excluding old journal usage does **not** make newly sending inherited context free. Pi 1.0 attribution uses finalized execution/wait tool results, not the removed `recordUsage` hook. Background notifications alone do not enter parent totals. Claude totals may remain explicitly accounting-incomplete when per-category evidence is unavailable. See [usage accounting](../README.md#usage-accounting); local attribution is not an additional provider request.

To investigate an actual spike, compare provider usage for the relevant time/model/account with parent and child native usage, launch counts, effective `fresh`/`fork` settings and context sizes. Do not sum attributed parent totals and the same child totals as independent traffic. Keep private prompts, journals and credentials out of public issues.

Use existing controls deliberately: prefer fresh context when a bounded handoff suffices, use file-only output when the parent needs references rather than full text, and set suitable concurrency and child runtime/token limits. `maxTokens` is best-effort and is not an invoice or whole-account spending cap. This investigation changes no profile defaults, fork capability, notice routing or quotas.
