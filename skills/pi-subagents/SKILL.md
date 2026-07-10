---
name: pi-subagents
description: "Pi subagent orchestration: delegate to builtin/custom agents; run single, parallel, chain, async/background, forked-context, acceptance, worktree, intercom, status/control, or agent-management workflows. Do not use for Agent Skill maintenance, spawned child prompts, or non-Pi delegation."
---

# Pi Subagents

Parent-orchestrator skill for launching focused child Pi sessions. Do not inject or follow this skill inside ordinary spawned child subagents.

## Trigger boundary

Use this for runtime Pi subagent orchestration, not for maintaining Agent Skill files. If the user asks to create, harden, validate, or optimize `SKILL.md`, `skills/...`, evals, scripts, or trigger descriptions, use `agent-skill-engineering` instead.

## Hard constraints

- The parent session owns orchestration, decisions, review synthesis, and final user-facing status.
- Before executing subagents in a session, call `subagent({ action: "list" })` unless the executable agent/chain is already known; treat its descriptions as the current role/model policy.
- Treat child output as evidence to inspect, not automatic truth.
- Keep writes single-threaded unless writers are isolated with `worktree: true`.
- Use fresh-context reviewers for adversarial review; use forked `oracle` for inherited-decision/drift review.
- Do not let ordinary children launch subagents. Only a child explicitly configured with `allowSubagents: true` or the `subagent` tool may run bounded fanout assigned by the parent.
- A reviewer timeout is not sign-off. Foreground reviewer budgets are raised to a safe floor; planner/researcher budgets are raised only from local history. Rerun, resume, or split timed-out work.
- Use async/background only when the parent can keep doing useful independent work or the user wants chat unblocked. Do not sleep-poll; check status when evidence is needed.
- When an active Pi goal is incomplete, prefer foreground/blocking subagent runs for goal-critical evidence.
- Use `acceptance` for goal-style requests and plan/spec/broad-fix worker handoffs; put criteria, evidence, verify commands, stop rules, and loop cap there instead of burying them only in task prose.
- Do not set `acceptance` on static parallel groups or dynamic fanout aggregate groups; set it on each child task/template that owns a session.

## Quick tool patterns

### List / diagnose

```ts
subagent({ action: "list" })
subagent({ action: "doctor" })
```

### Single agent

```ts
subagent({
  agent: "oracle",
  task: "Review my current direction, challenge assumptions, and propose the safest next move."
})
```

### Parallel review

```ts
subagent({
  context: "fresh",
  tasks: [
    { agent: "reviewer", task: "Review the current diff for correctness. Do not modify project/source files." },
    { agent: "reviewer", task: "Review the current diff for test and validation gaps. Do not modify project/source files." },
    { agent: "reviewer", task: "Review the current diff for unnecessary complexity. Do not modify project/source files." }
  ],
  concurrency: 3
})
```

### Chain

```ts
subagent({
  chain: [
    { agent: "scout", task: "Map the relevant code and risks." },
    { agent: "planner", task: "Create an implementation plan from: {previous}" },
    { agent: "worker", task: "Implement the approved plan from: {previous}" }
  ]
})
```

### Async/background

```ts
subagent({ agent: "scout", task: "Map the auth flow.", async: true })
subagent({ action: "status", id: "run-id" })
subagent({ action: "status", id: "latest" }) // latest remembered foreground run in this session
subagent({ action: "extend", id: "foreground-run-id", extendMs: 300000 })
subagent({ action: "resume", id: "run-id", message: "Continue with this clarification..." })
subagent({ action: "nudge", id: "run-id", message: "What are you blocked on?" })
```

### Worker handoff with acceptance

```ts
subagent({
  agent: "worker",
  task: "Implement the approved plan at docs/plan.md. Stop for unapproved product decisions.",
  acceptance: {
    criteria: [
      "Implementation follows the approved plan",
      "Focused validation for changed behavior passes",
      "Residual risks or skipped checks are reported"
    ],
    evidence: ["changed-files", "commands-run", "validation-output", "residual-risks"],
    stopRules: ["Do not expand scope beyond the approved plan"],
    maxFinalizationTurns: 3
  }
})
```

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

## Prompt-template workflows

When a request matches a packaged workflow, apply the same pattern directly with `subagent(...)`:

- `/parallel-review`: fresh reviewers with distinct angles, then parent synthesis.
- `/review-loop`: worker → fresh reviewers → synthesized fix worker until clean or capped.
- `/parallel-research`: combine local scout/context with external researcher evidence.
- `/parallel-context-build`: parallel context-builder passes, then parent synthesis.
- `/parallel-handoff-plan`: external research plus local context into an implementation-ready handoff.
- `/gather-context-and-clarify`: scout/research first, then ask only unresolved material questions.
- `/parallel-cleanup`: read-only cleanup reviewers for deslop/verbosity/simplicity.

## Intercom bridge

`pi-subagents` works without `pi-intercom`. When the bridge is active, children may get `contact_supervisor`.

- `contact_supervisor({ reason: "need_decision", message })`: blocking decision/clarification.
- `contact_supervisor({ reason: "progress_update", message })`: concise non-blocking plan-changing update.
- Use `subagent({ action: "status", id })`, then `subagent({ action: "nudge", id, message })` for a non-blocking live child ping; use the status-shown `intercom({ action: "ask", delivery: "steer" })` when a reply must block.
- Do not use intercom/contact_supervisor for routine completion handoffs; return normal child results.
- If bridge messages do not appear, run `subagent({ action: "doctor" })`.

## Reference docs

Load these only when needed:

- `references/full-orchestration-guide.md` — full pre-split guide with all detailed recipes, settings, examples, and edge cases.

## Stop rules

Stop when the delegated work has produced the needed evidence, review/fix loops have no material remaining findings or hit a real blocker/cap, and the parent has verified enough to report accurately.
