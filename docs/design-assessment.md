# pi-subagents / intercom design assessment

Assessment date: 2026-09-06 UTC. Source: `01c89fb070c928aad0d842f2aba38dca20e187bf` (`0.34.18`). Source tree: `cd20e50a909f23fbfd0deb0ca44ffa212ab5da8f`.

Assessment only: no runtime changes, commits, publication, or replacement of the installed package. This report is the only intended repository change.

## Recommendation

**Keep the package, deliberately simplify its runtime, and redesign the everyday agent-facing interface. Do not start with a greenfield rewrite.**

The goal is not “more agents” or “a bigger workflow engine.” It is:

> Delegate once, retain ownership, ask and answer without losing work, get a trustworthy result, and return to the same specialist later.

The current implementation already contains valuable process isolation, session persistence, live steering, background completion, structured handoffs, worktrees, and recovery. Its central weakness is that foreground, background, and detached-foreground execution separately implement overlapping lifecycle and completion policy. The same request can change meaning depending on its route.

Four agent assessments and one working coordinator's field report informed this review. Architecture and oracle reviewers favored incremental refactoring; the Claude reviewer additionally favored replacing the agent-facing API; the safety reviewer favored targeted boundary fixes. None recommended throwing the entire package away. Their findings were checked rather than accepted wholesale: some security claims and a callback-race probe were downgraded or rebutted below.

## What I examined and exercised

- Architecture and callers across discovery/configuration, prompt assembly, child execution, retries, chains/fanout, worktrees, acceptance, result delivery, intercom, lifecycle restoration, and agent-facing documentation.
- Repository history and shape: 108 source TypeScript files / 35,909 lines; 101 test TypeScript files / 34,482 lines. Size is context, not evidence of bad design.
- Installed package and working checkout both at the assessed SHA. Active Pi: **0.85.1**; Node: **24.20.0**.
- Initial `npm run ci`: passed, but the preexisting checkout dependencies were stale Pi **0.80.9**, despite the manifest/lock pinning **0.84.0**.
- Repeated the gate from an isolated `git archive HEAD` after a real `npm ci`: **702 unit + 570 integration tests passed**, with the four Pi development packages verified at **0.84.0**. Typecheck, package smoke, and isolated install smoke passed as part of that gate.
- `npm run smoke:real-pi`: passed actual isolated package/resource loading on active Pi 0.85.1. This command's LLM modes were not run; separate live tool exercises provided model-backed evidence.
- Live async dispatch to GPT-, Claude-, and Grok-backed roles; status/discovery; nonblocking nudges; an intentionally deferred peer message and response.
- Live foreground `contact_supervisor` decision: foreground wait detached, parent replied, child returned the exact supplied token. Run `74b3bab3`.
- Live revival from that saved conversation recalled the token without being supplied it again. Run `74b3bab3 → 5fdf5e11`.
- Live forked oracle preserved the relevant decisions and its child role, but its valid advisory output was mislabeled failed by the mutation guard. Run `80c6b995-2b53-4f61-b126-7421a4693de2`.
- Focused process/Git/contract reproductions below, rerun against the clean pinned-dependency checkout where noted.

Evidence directory: `/tmp/pi-subagents-assessment.FhIBiR/`. Important files: `clean-install-cwd.log`, `clean-ci.log`, `clean-ci.exit`, `real-pi-smoke.log`, `pinned-probes.log`, `abort-probe.log`, and the runnable `*-probe.mjs` / `probes.mjs` scripts. These are local temporary artifacts; the results and acceptance checks are recorded here so the report does not depend on their indefinite retention.

### Performance observations

Five interleaved, isolated RPC startup/get-commands/exit samples, without model calls:

| Configuration | Median |
| --- | ---: |
| Pi without extensions | 149.7 ms |
| Pi with both package extensions | 550.8 ms |
| Difference | 401.1 ms |

This is not a full-profile startup, steady-state memory, or model-latency benchmark. It does **not** justify a permanent worker pool.

The activated orchestration schema is **24,599 serialized bytes and 36 top-level fields**. That excludes the surrounding skill/guideline material and is not an exact token count. Lazy activation is useful; the oversized everyday contract still merits simplification.

## Existing architecture

```text
Tool / slash / prompt bridge
           |
 discover -> validate -> prepare
           |
   +-------+-----------------------+
   |                               |
Foreground host                Background launch
runSync                        serialized configuration
runSingleAttempt               detached runner
   |                           runSingleStep / runPiStreaming
   +---------------+---------------+
                   |
         isolated Pi JSON child
         or Claude Code backend
                   |
    output + acceptance + status + artifacts
                   |
  callbacks / files / watchers / intercom relays
```

Key duplication:

- Child attempts: `src/runs/foreground/execution.ts:249` and `src/runs/background/subagent-runner.ts:293`.
- Retries and finalization: `execution.ts:1311` and `subagent-runner.ts:764`.
- Workflow execution: `src/runs/foreground/chain-execution.ts:418` and `subagent-runner.ts:1356`.
- Result truth is distributed across returned results, artifact metadata, async status, result files, remembered foreground runs, and notification formatting.

Splitting these files into smaller files would not solve duplicated semantics.

## Confirmed defects and concrete fixes

“Reproduced” below means the actual package functions were exercised. Mock-stream cases are distinguished from live model cases.

### 1. Binary worktree edits are not preserved before cleanup

**High: data loss. Reproduced with real Git and the public worktree lifecycle.**

`src/runs/shared/worktree.ts:447–458` captures `git diff --cached <base>` without `--binary`. `cleanupSingleWorktree` at `:486` then removes the worktree and branch after that capture appears successful.

A binary edit produced `filesChanged: 1`, no capture error, and a patch containing only “Binary files differ.” The worktree was removed; `git apply --check` failed with “cannot apply binary patch ... without full index line.” Loose Git objects may remain temporarily, but the promised patch is not a usable handoff.

**Smallest fix:** binary-capable patch capture; preserve the workspace on capture failure. Also use the existing private temp root for worktrees, especially on shared-`/tmp` platforms.

**Acceptance:** text, binary additions/modifications/deletions, and mode changes survive capture and cleanup and reproduce the expected tree when applied to the recorded base.

### 2. A first final answer can kill subsequent work and still report success

**High: false success. Reproduced with a controlled child JSON stream; supported by Pi's documented continuation lifecycle.**

`execution.ts:440–490,745–750,819–825` arms a one-second termination timer on an assistant `stop`, not final session settlement. Background duplicates this at `subagent-runner.ts:487–490,568–584`.

The probe emitted a first answer, started a subsequent turn/tool, then intended to finish that tool and answer. The timer killed it mid-tool, yet returned `exitCode: 0`, output “First answer,” and `currentTool: bash`. This matters for the supported near-completion nudge/follow-up path.

**Smallest fix:** distinguish assistant-message completion from final settlement and process cleanup. Use authoritative Pi settlement; never retain a success flag from an earlier answer while terminating newer work. Preserve bounded cleanup for genuinely stuck processes. The original reason for stuck-child cleanup needs confirmation rather than assuming it is the intercom socket.

**Acceptance:** a queued follow-up around the first answer completes, or reports explicit interruption/failure, never stale success. Cover foreground and background.

### 3. Abort can detach instead of stopping a child after any intercom use

**High: stop semantics. Reproduced with a controlled child process.**

`execution.ts:684–686` permanently sets `intercomStarted` for any intercom/supervisor tool start. At `:872–880`, parent abort detaches if that flag is set. A completed, nonblocking `intercom status` was sufficient: abort returned a detached result and the child continued to its final answer. No blocking question was pending.

**Smallest fix:** separate “release the parent wait to answer this live question” from cancellation. Use an actual pending blocking request, not “intercom was ever used.” Explicit cancellation must stop owned work and descendants.

**Acceptance:** abort after intercom status/progress/finished ask stops the child; a currently blocking question can still release a foreground wait without deadlock.

### 4. Verification timeouts do not stop the command tree

**High: post-timeout side effects. Reproduced with a real shell descendant.**

`src/runs/shared/acceptance-evaluation.ts:103–163` spawns a shell, signals only its PID, waits for piped stdio to close, and receives no cancellation signal.

A 50 ms verification timeout around `(sleep 1; write-marker) & wait` returned after about 1,020 ms, and the marker was written after the deadline. An indefinitely alive descendant can extend this much further.

**Smallest fix:** use one cancellation-aware process-tree runner for verification as well as child execution. Retain supported shell commands; replacing every verification command with `execFile` would break existing command composition.

**Acceptance:** timeout/abort stops descendants, prevents a delayed marker write, and returns within a bounded cleanup interval.

### 5. Correct advisory work is failed because prose contains editing words

**High: false failure. Reproduced in a live forked oracle and pure helper checks.**

`src/runs/shared/completion-guard.ts:117–173` infers required mutation from words such as “fix” and “refactor,” with incomplete negation handling. Our oracle was explicitly asked for advice with no implementation. It produced that advice, then was marked failed for not editing files.

A second example, `Read-only investigation. Explain how to fix the bug. Do not write files.`, also resolves to “mutation required.”

**Smallest durable fix:** stop turning guessed intent into a hard execution failure. Keep a warning if useful, or require an explicit mutation/acceptance expectation. Add role defaults only as a compatibility measure, not another growing regex taxonomy.

**Acceptance:** planner/oracle/debugger advisory requests succeed without edits; explicitly required implementation evidence is still enforced. Valid no-op fixes must also be representable.

### 6. Disabled project-context inheritance does not match current Pi

**High: context contract violation. Reproduced using active Pi's actual prompt builder.**

`src/runs/shared/subagent-prompt-runtime.ts:46,65–70` strips the old `# Project Context` text. Pi 0.85.1 builds `<project_context>` blocks. A sentinel project instruction remained after `inheritProjectContext: false` rewriting.

**Smallest fix:** use Pi's native `--no-context-files` rather than reparsing presentation text. Keep intentional selected context separate from inherited project instructions.

**Acceptance:** a real child with inheritance disabled does not receive a sentinel project instruction; enabling inheritance restores it. Repeat against the supported Pi floor and current release.

### 7. Foreground artifact metadata can contradict acceptance

**Medium: inconsistent evidence. Reproduced with the real foreground runner and controlled child responses.**

`execution.ts:1484–1502` writes metadata before acceptance/finalization at `:1524–1549`. The probe returned rejected acceptance and exit code 1, but its metadata recorded exit code 0. Runtime usage included two turns; metadata included one.

**Smallest fix:** finalize the authoritative result before writing terminal metadata, and include finalization evidence in the final result projections. The current initial-answer-only output policy should be revisited explicitly, since finalization is allowed to repair work.

**Acceptance:** result, metadata, status, and visible outcome agree after successful and rejected finalization, including usage.

### 8. Material progress can disappear while the parent is busy

**Medium: lost coordination. Source-traced, with an existing test confirming the behavior.**

`src/pi-intercom/index.ts:32,920–923,984,999,1056` drops supervisor progress updates older than 60 seconds. The sending tool at `:1729–1757` reports acceptance/sending, while the prescribed operation is deferred. A parent can legitimately stay busy for longer than a minute.

This is reasonable for superseded heartbeat noise, not for the latest material finding or a watcher's one significant transition. The sender retains an `intercom_sent` entry, so it is not literally erased from every transcript; the parent may never receive it.

**Smallest fix:** retain the latest meaningful milestone per run until delivered or explicitly superseded. Do not treat age alone as obsolescence. Make “accepted,” “delivered,” and “consumed” distinct where they matter.

**Acceptance:** the latest material update survives a parent busy for over a minute; obsolete updates are coalesced without wakeup spam.

### Additional source-traced correctness fixes

These reinforce the shared-executor recommendation; they were not all exercised through a real UI/model:

- **Acceptance lost during UI routing:** `run-single-path.ts:142–167` switches a clarified single run to background without forwarding `acceptance`; direct async dispatch forwards it. Changing presentation mode must not weaken the contract.
- **Group cwd propagation:** `chain-execution.ts:625` computes a parallel group's cwd but passes the outer cwd at `:704`; async serialization at `async-execution.ts:433–438` omits group cwd. Check every supported group/task cwd combination before consolidation.
- **Parallel output behavior diverges:** foreground `resolveParallelBehaviors` namespaces relative outputs; background chain setup uses `resolveStepBehavior` and may reject the same requested relative filenames as duplicates. Choose the intended contract, then make both modes identical.
- **Parent model inheritance is incomplete:** a fresh delegate with no explicit/profile model omits `--model`, leaving selection to the child's defaults rather than necessarily the parent's selected model. Resolve the exact inherited model before spawning.
- **Child cwd trust:** `subagent-executor.ts:289–292` applies the parent's trust boolean to discovery in a potentially different cwd; `pi-args.ts:90–97` defaults child runs to `--approve`. Preserve explicit authorization, but do not infer trust in a new repository from trust in the parent repository.
- **Misleading intercom reason:** `peer_idle` is used when a peer reports `accepts_asks: false` while busy. Return an accurate reason and state whether the question was delivered but no longer being awaited.

## What the agents actually want

### 1. One view of everything I delegated

A parent-scoped view across child working directories, showing task, role, current attempt, state, latest child-reported milestone, pending question, and evidence paths. Include completed-but-unreviewed results, not only currently running jobs.

The live coordinator independently reported that project-scoped peer discovery hid its own children in another worktree. Existing managed `status`/`nudge` still worked, so this is a discovery/ownership improvement, not a claim that those children were uncontrollable.

Distinguish resuming the same parent conversation from creating a new one. Offer explicit discovery/adoption of old work; never silently inject another session's results.

### 2. Questions that survive lunch

A durable `awaiting_input` state and question ID, with answers routed to the run rather than only an ephemeral process. Waiting should not require a response within the current two-minute intercom timeout.

Use existing saved child sessions for continuation. Do not build a separate task-management service. A child can checkpoint and later revive; keeping every blocked process warm is not required.

### 3. Return to a specialist without reconstructing the session

Build on working `resume`, with clear continuation lineage. A late nudge should return “already completed” plus the result reference, not merely a “not live” error and a separate event. It must not silently restart the child and spend tokens.

Fresh reviewers remain fresh: resuming a reviewer is not independent review.

### 4. Deliberate context, with provenance

Fresh and fork are valuable. The everyday middle ground is already expressible as an explicit handoff: selected decisions, findings, files, and artifact references. Make that convenient and inspectable before adding a third automatic context engine.

Expose effective role/profile source, model/fallbacks, tool/extension policy, cwd/trust, selected context, output ownership, and limits. This would have made the stale dependencies and unexpectedly shadowing home-level “project” profiles easier to diagnose.

The forked oracle understood its role, but inherited substantial irrelevant reading output and historical orchestration-skill text. Fork filtering is useful, not a promise of minimal or fully sanitized context.

### 5. Less ceremony, more truthful outcomes

Separate ordinary delegation, run control, and rarely used definition/workflow administration. Keep advanced capabilities lazy and retain a compatibility adapter for existing callers.

Illustrative surface, not an approved schema:

```text
delegate(task, agent, context, cwd, limits, acceptance) -> run handle
runs(list | inspect | stop | continue | answer, run handle) -> structured state
intercom(send | reply | discover, peer) -> delivery receipt
advanced workflows / agent definitions -> separately loaded
```

A run should have one durable identity; attempts, child sessions, message IDs, and workflow positions should not compete as user-facing handles. Foreground versus background should primarily mean whether the parent waits, not which completion semantics apply.

Keep outcome, validation, and delivery distinct: “execution finished,” “checks passed,” “parent notified,” and “parent accepted this work” are different facts. Preserve raw evidence. Add useful usage/cost accounting across attempts and finalization using Pi's native facilities where supported, without equating tool counts with progress.

### 6. Safe workspace handoffs and bounded fanout

Make isolation usable for a single writer as well as parallel writers. Preserve binary-capable output and expose the base commit and patch/worktree receipt. A small advisory ownership mechanism can help agents avoid shared-checkout collisions; it is not an OS sandbox.

Per-call parallel limits do not bound many separate asynchronous launches across parent sessions. If real usage needs a global/local budget, add one small admission limit with visible queueing, not a general distributed scheduler.

## Target implementation direction

```text
Existing interfaces + smaller everyday tools
                    |
          resolve one run specification
                    |
          one execution/workflow core
                    |
          isolated child attempt control
                    |
     finalized result + durable run/question state
                    |
     foreground wait / background notification
     status / artifacts / UI as projections
                    |
      intercom for live peer communication
```

Keep the foreground and detached hosts concrete. Share behavior, not an elaborate plugin framework. The existing sequential/parallel/fanout model does not require an arbitrary DAG language.

### Test RPC before committing to a large extraction

The oracle's strongest counterargument to “just share the existing runner” is valid: current Pi RPC may let us delete some process-control and continuation machinery rather than merely centralize it. RPC still preserves subprocess isolation.

Run one bounded, disposable comparison before choosing the long-term control transport:

1. Task, near-final follow-up, and authoritative settlement.
2. Abort during real tool work, including descendants.
3. Same-session continuation and a pending supervisor question.
4. The same control code behind a foreground wait and detached execution.
5. Parent disconnect/reconnect while ownership and the result survive.

Choose RPC only if it preserves those capabilities and measurably reduces code. It does not itself supply durable ownership, offline inboxes, human approval, or safe workspace integration. Native JSON already exposes settlement events, so no RPC migration is needed to fix the confirmed premature-completion bug.

## Security judgments and explicit non-findings

- **Same-user IPC impersonation:** client-asserted names/project labels are not authenticated identities. However, the stated Pi boundary already trusts code running as the same OS user, and project filtering is explicitly advisory. Such a process can already edit session/config files. I do **not** accept “same-user bus permits cross-project sends” as a demonstrated privilege escalation or justification for mandatory project ACLs. Cross-project coordination is an intended capability used in this assessment. Optional parent-only child messaging can reduce mistakes; hostile-agent isolation requires OS/container boundaries and appropriately isolated credentials/transports.
- **Checked acceptance:** structured attestation is not independent proof. That distinction is documented, and runtime `verify` commands exist. Keep/improve the distinction; do not call every attested report a verification bypass.
- **Windows pipes/processes:** ownership and process-tree behavior were not tested on Windows. This is a coverage gap, not a proven Windows vulnerability. Add platform proof if Windows remains supported.
- **Worktree privacy:** the code places worktrees outside the private runtime root. Shared Linux `/tmp` deserves explicit permission protection; a macOS user-temp fixture is not a demonstration of cross-user disclosure.
- **Session sharing:** `share: true` deliberately exports transcripts externally and is disabled by default. No sharing occurred. Preserve clear disclosure and require user authorization under the surrounding agent policy; this review does not introduce an extra mandatory confirmation system.
- **Broker spawn-lock races:** not reproduced; retain as a targeted reliability test question, not a headline defect.
- **Watcher session-transition probe:** a plain helper/event-bus probe allowed an in-flight result to cross a simulated session change. Active Pi 0.85.1 deactivates old extension APIs and guards `pi.events.emit/on` with `assertActive()`. The probe did not establish a real crossover on that runtime; it is excluded from confirmed defects. Add a real replacement/reload test before asserting failure or changing delivery.
- **Anthropic fork restriction:** the inspected code/docs state the rule without explaining its rationale. Do not remove a potentially intentional provider/contract restriction without asking why it exists. Document and revisit it separately.

## Proposed order of work

1. **Reliability patch set:** binary preservation, cancellation/settlement, verification process-tree cleanup, false mutation failures, native context suppression, acceptance forwarding and metadata consistency. Each change gets a behavioral regression check; no public redesign required first.
2. **Small RPC/control experiment:** decide whether to share the current transport or replace it using concrete deletion and capability evidence.
3. **One resolved contract and runtime:** consolidate one child-attempt lifecycle, then workflow execution and finalized result projections. Preserve existing public calls during migration. Cross-mode parity tests are the acceptance bar.
4. **Agent UX revision:** compact delegation/control, parent-owned run view, durable questions, completion-aware follow-up, explicit context/profile provenance, and reliable material milestones.
5. **Only demonstrated demand:** on-demand specialist conveniences, admission budgets, broader isolation/platform support. Remote execution, shared memory, autonomous task claiming, permanent pools, and a replacement broker need real requirements before investment.

Preserve process isolation, local IPC/reconnect, fresh and forked contexts, parent-owned orchestration, structured outputs, independent reviews, bounded concurrency, worktree safety, saved sessions, artifact references, and automatic async completion. Delete duplicated policy and misleading inference, not useful capabilities.

## Remaining evidence limits

This was an architecture/product/safety assessment, not a certification or full platform matrix. No Windows/Linux runtime, exhaustive TUI keyboard/rendering dogfood, every provider fallback route, live crash/restart fault matrix, or remote sharing was exercised. Mock-stream reproductions establish package behavior for a reachable event sequence; they are not claims that the corresponding live race occurred during every dispatch. Proposed fixes have not been implemented.

**Suggested next authorization:** approve the reliability patch set and a bounded RPC comparison, then review the compact API/ownership design before migration. No nuke needed.
