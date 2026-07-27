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
- Use async/background only when the parent can keep doing useful independent work or the user wants chat unblocked. Launch a small bounded fanout of independent async agents as separate single-agent runs so each completion wakes the parent, with at most one writer. Use one async `tasks` call when all child results are required together, when shared concurrency/task limits are needed, or when multiple writers require `worktree: true`; the parent receives one aggregate completion. Do not sleep-poll; check status when evidence is needed.
- When an active Pi goal is incomplete, prefer foreground/blocking subagent runs for goal-critical evidence.
- Use `acceptance` for goal-style requests and plan/spec/broad-fix worker handoffs; put criteria, evidence, verify commands, stop rules, and loop cap there instead of burying them only in task prose. Revived runs inherit that contract unless the resume call explicitly overrides `acceptance`.
- Independent review stays parent-controlled: never put `review` inside `acceptance`; launch reviewer subagents separately after the worker completes.
- Do not set `acceptance` on static parallel groups or dynamic fanout aggregate groups; set it on each child task/template that owns a session.

## Agent selection

Use the effective agents from `subagent({ action: "list" })`; user/project profiles may replace builtin role behavior. Common roles:

- `scout`: fast codebase recon and handoff context.
- `researcher`: external/web/docs research with sources.
- `planner`: concrete implementation plans; should read and plan, not edit.
- `worker`: single-writer implementation for approved scope.
- `reviewer`: review and small fixes when explicitly allowed.
- `context-builder`: stronger context/meta-prompt handoff builder.
- `oracle`: forked advisory second opinion for direction, drift, and assumptions.
- `delegate` if present: lightweight generic child; prefer a specialist or `worker` when the task has a real role.

Keep configured defaults for routine runs. Pass `model`/`thinking` only when the listed agent description, user request, or clear task risk justifies it; put the override in the subagent call, not only in prose. Pass explicit `context: "fresh"` or `"fork"` only when one policy should override every child in the call. Fork is rejected for effective `anthropic/` primary or fallback models, and explicit overrides cannot bypass that restriction.

## Intercom bridge

`pi-subagents` works without `pi-intercom`. When the bridge is active, children may get `contact_supervisor`.

- `contact_supervisor({ reason: "need_decision", message })`: blocking decision/clarification.
- `contact_supervisor({ reason: "progress_update", message })`: concise non-blocking plan-changing update.
- Use `subagent({ action: "status", id })`, then `subagent({ action: "nudge", id, message })` for a non-blocking live child ping; use the status-shown `intercom({ action: "ask", delivery: "steer" })` when a reply must block.
- Do not use intercom/contact_supervisor for routine completion handoffs; return normal child results.
- If bridge messages do not appear, run `subagent({ action: "doctor" })`.

## Detailed recipes

Load `references/full-orchestration-guide.md` only when you need concrete `subagent(...)` call shapes, packaged prompt-template workflows (`/parallel-review`, `/review-loop`, `/parallel-research`, `/parallel-context-build`, `/parallel-handoff-plan`, `/gather-context-and-clarify`, `/parallel-cleanup`), staged fix orchestration, settings, or edge cases. Do not reload it for every routine launch.

## Stop rules

Stop when the delegated work has produced the needed evidence, review/fix loops have no material remaining findings or hit a real blocker/cap, and the parent has verified enough to report accurately.
