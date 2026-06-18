---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, chain,
  parallel, async, forked-context, and intercom-coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution.
---

# Pi Subagents

Parent-orchestrator skill for launching focused child Pi sessions. Do not inject or follow this skill inside ordinary spawned child subagents.

## Hard constraints

- The parent session owns orchestration, decisions, review synthesis, and final user-facing status.
- Before executing subagents in a session, call `subagent({ action: "list" })` unless the executable agent/chain is already known.
- Treat child output as evidence to inspect, not automatic truth.
- Keep writes single-threaded unless writers are isolated with `worktree: true`.
- Use fresh-context reviewers for adversarial review; use forked `oracle` for inherited-decision/drift review.
- Do not let ordinary children launch subagents. Only a child explicitly configured with `allowSubagents: true` or the `subagent` tool may run bounded fanout assigned by the parent.
- A reviewer timeout is not sign-off. Rerun, resume, or split the review.
- When an active Pi goal is incomplete, prefer foreground/blocking subagent runs for goal-critical evidence.

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

## Builtin agents

- `scout`: fast codebase recon and handoff context.
- `researcher`: external/web/docs research with sources.
- `planner`: concrete implementation plans; should read and plan, not edit.
- `worker`: single-writer implementation for approved scope.
- `reviewer`: review and small fixes when explicitly allowed.
- `context-builder`: stronger context/meta-prompt handoff builder.
- `oracle`: forked advisory second opinion for direction, drift, and assumptions.
- `delegate`: lightweight generic child.

Builtin `planner`, `worker`, and `oracle` default to forked context. Pass `context: "fresh"` when a fresh child is intended.

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
- Do not use intercom/contact_supervisor for routine completion handoffs; return normal child results.
- If bridge messages do not appear, run `subagent({ action: "doctor" })`.

## Reference docs

Load these only when needed:

- `references/full-orchestration-guide.md` — full pre-split guide with all detailed recipes, settings, examples, and edge cases.

## Stop rules

Stop when the delegated work has produced the needed evidence, review/fix loops have no material remaining findings or hit a real blocker/cap, and the parent has verified enough to report accurately.
