---
name: pi-subagents
description: "Pi subagent orchestration: delegate to builtin/custom agents; run single, parallel, chain, async/background, forked-context, acceptance, worktree, intercom, status/control, or agent-management workflows. Do not use for Agent Skill maintenance, spawned child prompts, or non-Pi delegation."
---

# Pi Subagents

Parent-orchestrator skill for launching focused child Pi sessions. Parent owns orchestration, decisions, review synthesis, and final user-facing status. Do not inject or follow this skill inside ordinary spawned child subagents. For Agent Skill file maintenance (`SKILL.md`, evals, trigger descriptions), use `agent-skill-engineering` instead.

## Hard constraints

- Before executing subagents in a session, call `subagent({ action: "list" })` unless the executable agent/chain is already known; treat its descriptions as the current role/model policy.
- Treat child output as evidence to inspect, not automatic truth.
- Keep writes single-threaded unless writers are isolated with `worktree: true`.
- Use fresh-context reviewers for adversarial review; use forked `oracle` for inherited-decision/drift review.
- Do not let ordinary children launch subagents. Only a child explicitly configured with `allowSubagents: true` or the `subagent` tool may run bounded fanout assigned by the parent.
- A reviewer timeout is not sign-off. Foreground reviewer budgets are raised to a safe floor; planner/researcher budgets are raised only from local history. Rerun, resume, or split timed-out work.
- Subagent execution defaults to async/background. Launch a small bounded fanout as separate single-agent runs so each completion wakes the parent, with at most one writer. Continue useful parent work while children run; if none remains, end the turn and wait for completion instead of polling. Use one `tasks` call for non-review fanout when all child results are required together, when shared concurrency/task limits are needed, or when multiple writers require `worktree: true`; the parent receives one aggregate completion. Check status only when the user asks or the run may be blocked or stale.
- When an active Pi goal is incomplete and child evidence must arrive before the next goal step, set `async: false` and do not end the turn before that evidence arrives. Use `async: false` for any other deliberate foreground dependency; do not rely on omission.
- Use `acceptance` for goal-style requests and plan/spec/broad-fix worker handoffs; put criteria, evidence, verify commands, stop rules, and loop cap there instead of burying them only in task prose. Revived runs inherit that contract unless the resume call explicitly overrides `acceptance`.
- Omit `acceptance` from review-only tasks unless the user explicitly requests a same-session acceptance contract; it adds a finalization turn and does not provide independent review.
- Independent review stays parent-controlled: never put `review` inside `acceptance`; launch reviewer subagents separately after the worker completes.
- Do not set `acceptance` on static parallel groups or dynamic fanout aggregate groups; set it on each child task/template that owns a session.

## Agent selection

Use the effective agents from `subagent({ action: "list" })`; user/project profiles may replace builtin role behavior. Common roles:

- `scout`: fast codebase recon and handoff context.
- `context-builder`: stronger context/meta-prompt handoff builder.
- `researcher`: evidence-driven technical research.
- `watcher`: read-only async monitoring; define material transitions and a terminal condition in the task.
- `planner`: concrete implementation plans; should read and plan, not edit.
- `worker`: single-writer implementation for approved scope.
- `debugger`: root-cause diagnosis and repair evidence.
- `fixer`: bounded remediation after findings are already decided.
- `reviewer`: general implementation review.
- `reviewer-gpt`: strict maintainability and correctness gate.
- `reviewer-claude`: independent cross-model assumptions and product-risk review.
- `reviewer-security`: security and data-safety review for trust boundaries.
- `ui-designer`: rendered UI, layout, accessibility, and visual polish.
- `writer`: human-facing documentation and polished copy.
- `oracle`: forked advisory second opinion for direction, drift, and assumptions.
- `delegate`: lightweight generic child; prefer a specialist or `worker` when the task has a real role.

Keep configured defaults for routine runs. Pass `model`/`thinking` only when the listed agent description, user request, or clear task risk justifies it; put the override in the subagent call, not only in prose. Pass explicit `context: "fresh"` or `"fork"` only when one policy should override every child in the call. Fork is rejected for effective `anthropic/` primary or fallback models, and explicit overrides cannot bypass that restriction.

## Intercom bridge

`pi-subagents` bundles its intercom extension. Children always get `contact_supervisor` unless an explicit agent `extensions` allowlist omits `pi-intercom`.

- `contact_supervisor({ reason: "need_decision", message })`: steered blocking decision/clarification only when the ephemeral child cannot safely continue and must remain alive for one reply.
- `contact_supervisor({ reason: "interview_request", message, interview })`: steered blocking structured questions only when the ephemeral child cannot safely continue until it receives multiple answers.
- `contact_supervisor({ reason: "progress_update", message })`: concise non-blocking material update with intentionally deferred/coalesced delivery that may wait behind active supervisor work.
- Use `subagent({ action: "status", id })`, then `subagent({ action: "nudge", id, message })` for live child guidance, answers, corrections, or blockers. A nudge supplements the child's active task unless it explicitly says to replace it.
- Use the status-shown `intercom({ action: "ask", delivery: "steer" })` only when the parent must remain alive waiting for a child reply.
- Do not use intercom/contact_supervisor for routine completion handoffs; return normal child results.
- If bridge messages do not appear, run `subagent({ action: "doctor" })`.

## Detailed recipes

Load `references/full-orchestration-guide.md` only when you need concrete `subagent(...)` call shapes, packaged prompt-template workflows (`/parallel-review`, `/review-loop`, `/parallel-research`, `/parallel-context-build`, `/parallel-handoff-plan`, `/gather-context-and-clarify`, `/parallel-cleanup`), staged fix orchestration, settings, or edge cases. Do not reload it for every routine launch.

## Stop rules

Stop when the delegated work has produced the needed evidence, review/fix loops have no material remaining findings or hit a real blocker/cap, and the parent has verified enough to report accurately.
