---
name: pi-subagents
description: "Pi subagent orchestration: delegate to builtin/custom agents; run single, parallel, chain, async/background, forked-context, acceptance, worktree, intercom, status/control, or agent-management workflows. Do not use for Agent Skill maintenance or non-Pi delegation."
---

# Pi Subagents

Use this skill to coordinate focused Pi sessions. The original agent owns integration, review synthesis, and final delivery. Helpers with delegation enabled may split their assigned work when it saves time or improves quality. For Agent Skill file maintenance (`SKILL.md`, evals, trigger descriptions), use `agent-skill-engineering` instead.

## Hard constraints

- Prefer `delegate({ agent, task })` for a known profile; it enables run controls automatically. For discovery/history first, call `load_subagent({ advanced: false })`, then `agent_runs({ action: "profiles" })`. `agent_runs` provides list/inspect/history/search/nudge/continue/stop/questions/answer/review without loading the full schema.
- For parallel groups, chains, detailed overrides, or profile administration, call `load_subagent` if `subagent` is inactive.
- Discover profiles before execution with `agent_runs({ action: "profiles" })` or `subagent({ action: "list" })` unless already known; the list shows effective role, source, context and model/thinking/fallback defaults, marking unset choices as inherited rather than guessing runtime values.
- Treat child output as evidence to inspect, not automatic truth. Record parent review with `agent_runs({ action: "review", id, decision: "accepted" | "needs_changes", message? })`; this is parent-only, not sent to the child, and never launches work. Put actionable instructions in continue/nudge.
- The owned run list is attention-first and paged (default 20, maximum 100), not a history limit. Apply global `agent`/`state`/`text` filters and `sort`, then reuse the returned cursor with the same query; restart paging when it is stale. `history` reads bounded native previews for an owned `id`/child `index`; `search` accepts words or one quoted phrase, not operators or prefixes. Indexed freshness/excerpts never prove completion or delivery. Resume the same saved parent after reload/restart; inspect the original handle for concise results, paths and continuation history; use full:true for the full task/configuration. Live work precedes completed unreviewed rows.
- `continue` and exited-question revival keep saved launch settings, including override pinning. Explicit `agent` selects the current profile's model, thinking and fallbacks; a separate `model` override wins. Old runs without a saved profile require `agent`. Override `cwd`, `output`, or `acceptance` for a new continuation as needed; live guidance/answers never mutate model or acceptance. A late nudge or inspect never restarts a finished child.
- `continue`/`answer` with `async: false` waits for the actual continuation result. Important steers release foreground waits so the parent can respond while the child keeps working; completion arrives automatically.
- Stop acknowledgement is a request, not proof of agent or command exit. Use the separately recorded agent-process outcome and actual native tool results; missing command results mean exit unconfirmed.
- An observed human-only authentication boundary may report a criterion as `blocked`, with concrete `evidence` and an exact `humanAction`. Acceptance stays incomplete and finalization/verification stops until explicit Continue. Retain completed evidence; do not use this for ordinary errors or fixable work.
- Keep writes single-threaded unless writers are isolated with `worktree: true`.
- Use fresh-context reviewers for adversarial review; use forked `oracle` for inherited-decision/drift review. Fresh handoffs must include relevant exact original user instructions and settled decisions, or readable source references, alongside the bounded assignment. Summaries do not replace original requirements; the harness does not automatically forward the owner's transcript.
- Keep bundled children as leaf agents and launch useful fanout from the parent. Nested helpers require explicit user authorization and an already-enabled profile within its native depth budget; do not infer permission to change nesting settings. Keep the original agent responsible for the complete result; do not repeat approvals for already-authorized work.
- A reviewer timeout is not sign-off. Foreground reviewer budgets are raised to a safe floor; planner/researcher budgets are raised only from local history. Rerun, resume, or split timed-out work.
- Subagent execution defaults to async/background. Launch a small bounded fanout as separate single-agent runs so each completion wakes the parent, with at most one writer. Continue useful parent work while children run; if none remains, end the turn and wait for completion instead of polling. Use one `tasks` call for non-review fanout when all child results are required together, when shared concurrency/task limits are needed, or when multiple writers require `worktree: true`; the parent receives one aggregate completion. Check status only when the user asks or the run may be blocked or stale.
- An incomplete active Pi goal follows the same async workflow: if child evidence gates the next step, end the current turn and continue after automatic completion delivery. Do not advance past missing evidence. Use `async: false` for explicitly chosen foreground execution or a non-interactive one-shot caller that needs the result on stdout.
- Use `acceptance` for goal-style requests and plan/spec/broad-fix worker handoffs; put criteria, evidence, verify commands, stop rules, and loop cap there instead of burying them only in task prose. Revived runs inherit that contract unless the resume call explicitly overrides `acceptance`.
- Omit `acceptance` from review-only tasks unless the user explicitly requests a same-session acceptance contract; it adds a finalization turn and does not provide independent review.
- Independent review stays parent-controlled: never put `review` inside `acceptance`; launch reviewer subagents separately after the worker completes.
- Do not set `acceptance` on static parallel groups or dynamic fanout aggregate groups; set it on each child task/template that owns a session.

## Agent selection

Use effective agents from `agent_runs({ action: "profiles" })` or `subagent({ action: "list" })`; user/project profiles may replace builtin role behavior. Common roles:

- `scout`: fast codebase recon and handoff context.
- `context-builder`: stronger context/meta-prompt handoff builder.
- `researcher`: evidence-driven technical research.
- `watcher`: observation that needs ongoing interpretation; use ordinary tools for routine waiting and check collection. Define material transitions and a terminal condition.
- `planner`: concrete implementation plans; should read and plan, not edit.
- `worker`: single-writer implementation for approved scope.
- `debugger`: root-cause diagnosis and repair evidence.
- `fixer`: bounded remediation after findings are already decided.
- `reviewer`: general implementation review.
- `reviewer-gpt`: strict maintainability and correctness gate.
- `reviewer-claude`: independent cross-model assumptions and product-risk review.
- `reviewer-security`: security and data-safety review for trust boundaries.
- `reviewer-ponytail`: over-engineering and slop review; uses the `ponytail` skill when installed and never trades away intended behavior.
- `ui-designer`: rendered UI, layout, accessibility, and visual polish.
- `writer`: human-facing documentation and polished copy.
- `oracle`: forked advisory second opinion for direction, drift, and assumptions.
- `delegate`: lightweight generic child; prefer a specialist or `worker` when the task has a real role.

Profiles are reliable defaults, not override prohibitions. When warranted by the task, use `model: "provider/model:high"`, subject to user instructions and provider authorization; there is no standalone execution `thinking` argument. Explicit overrides pin route and effort: transient transport retries stay on that choice, with no profile fallback. On unavailability, the parent must choose a replacement. Ordinary launches keep profile fallbacks. Pass explicit `context: "fresh"` or `"fork"` only when one policy should override every child in the call. Fork is rejected for actual `anthropic/` primary or fallback candidates. A pinned non-Anthropic override excludes profile fallbacks; an Anthropic override remains ineligible.

## Intercom bridge

`pi-subagents` bundles its intercom extension. Children always get `contact_supervisor` unless an explicit agent `extensions` allowlist omits `pi-intercom`.

- `contact_supervisor({ reason: "need_decision", message })`: steered blocking decision/clarification only when the ephemeral child cannot safely continue and must remain alive for one reply.
- `contact_supervisor({ reason: "interview_request", message, interview })`: steered blocking structured questions only when the ephemeral child cannot safely continue until it receives multiple answers.
- `contact_supervisor({ reason: "progress_update", message })`: a non-blocking discovery or change the supervisor needs while working, delivered at the next tool boundary. Skip starts, redundant narration, and routine completion; retain material findings in the final result.
- Use `agent_runs({ action: "inspect", id })`, then `agent_runs({ action: "nudge", id, message })` for live child guidance, answers, corrections, or blockers. A nudge supplements the child's active task unless it explicitly says to replace it.
- Blocking supervisor questions are persisted and do not use the ordinary two-minute ask timeout. After reload/reconnect, resume the same saved supervisor session, call `agent_runs({ action: "questions" })`, then `agent_runs({ action: "answer", id, questionId, message })`. A nudge is not a question answer.
- Questions, answers, launch contracts, and results use persistent Pi session storage, not temporary logs. The live waiter reads the saved answer, or an exited child resumes its saved session with its saved launch configuration and acceptance contract. Identical repeated answers do not duplicate execution; an answer receipt is not run completion. `agent_runs({ action: "stop", id })` also cancels pending questions.
- Load `load_intercom({})` if intercom is inactive. Use the status-shown `intercom({ action: "ask", delivery: "steer" })` only when the parent must remain alive waiting for a child reply.
- Do not use intercom/contact_supervisor for routine completion handoffs; return normal child results.
- If bridge messages do not appear, call `load_subagent({})` if needed, then `subagent({ action: "doctor" })`.

## Detailed recipes

Load `references/full-orchestration-guide.md` only when you need concrete `subagent(...)` call shapes, example workflow recipes, staged fix orchestration, settings, or edge cases. Do not reload it for every routine launch.

## Stop rules

Stop when the delegated work has produced the needed evidence, review/fix loops have no material remaining findings or hit a real blocker/cap, and the parent has verified enough to report accurately.
