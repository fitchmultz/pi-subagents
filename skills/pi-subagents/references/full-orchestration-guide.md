---
name: pi-subagents
description: "Pi subagent orchestration reference for single, parallel, chain, async/background, forked-context, acceptance, worktree, intercom, status/control, and agent-management workflows. Do not use for Agent Skill maintenance, spawned child prompts, or non-Pi delegation."
---

# Pi Subagents

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, orchestration, review fanout, and final fix-worker launches; child subagents should receive concrete role-specific tasks. Ordinary children should not run their own subagent workflows; the explicit exception is a delegated fanout child configured with `allowSubagents: true` or whose resolved builtin `tools` includes `subagent`, and that child may use `subagent` only for the fanout work the parent assigned.

Use this skill when the parent orchestrator needs to launch a specialized subagent, compose multiple agents into a workflow, or create/edit agents and chains on demand.

## When to Use

- **Advisory review**: use fresh-context `reviewer` agents for adversarial code review, or fork to `oracle` when inherited decisions and drift matter
- **Implementation handoff**: have `oracle` advise, then `worker` implement only after an approved direction
- **Recon and planning**: use `scout` or `context-builder`, then `planner`
- **Parallel exploration**: run multiple non-conflicting tasks concurrently
- **Long-running work**: launch async/background runs and inspect them later
- **Long-running observation**: launch `watcher` asynchronously with explicit material-change and terminal conditions
- **Subagent control**: watch needs-attention signals and soft-interrupt only when a delegated run is genuinely blocked
- **Subagent definition management**: create, update, or override Pi agents and chains for a project

## Tool vs Slash Commands

Agents can use the `subagent(...)` tool directly for execution, management, status, and control.
Humans often use the slash-command layer instead:

- `/run` — launch a single agent
- `/chain` — launch a chain of steps
- `/parallel` — launch top-level parallel tasks
- `/run-chain` — launch a saved `.chain.md` or `.chain.json` workflow
- `/subagents-doctor` — diagnose setup, discovery, async paths, and the paired intercom target

Prefer the tool when you are writing agent logic. Prefer the slash commands when
you are guiding a human through an interactive flow.

The repository keeps example prompts for repeatable workflows. Treat them as reusable orchestration recipes. When the user asks for one of these shapes, or when the workflow clearly fits, apply the same pattern directly with `subagent(...)` and other tools:
- `prompts/parallel-review.md` — fresh-context reviewers with distinct review angles, then synthesis
- `prompts/review-loop.md` — parent-orchestrated worker, fresh-reviewer, and fix-worker cycles until clean or capped
- `prompts/parallel-research.md` — combine `researcher` and `scout` for external evidence plus local code context
- `prompts/parallel-context-build.md` — parallel `context-builder` passes that produce planning handoff context and meta-prompts
- `prompts/parallel-handoff-plan.md` — external-reference research plus local `context-builder` passes, followed by a synthesis handoff plan and implementation-ready meta-prompt
- `prompts/gather-context-and-clarify.md` — scout/research first, then ask the user clarifying questions with the available clarification tool (`ask_question` in pi)
- `prompts/parallel-cleanup.md` — two fresh-context reviewers (deslop + verbosity passes) for an adversarial cleanup review of the current diff

## Applying Example Prompt Techniques

The examples in `prompts/` encode workflows the parent agent can run on demand. If the user provides a URL, issue, PR, plan, local file, screenshot, or freeform target, treat that target as the primary scope: read or fetch it before launching children, then include it explicitly in every child task. Do not depend on the parent conversation history when the recipe calls for fresh context.

### Parallel review technique

Use this when the user wants adversarial review of a diff, plan, issue, file, or implemented work. Launch fresh-context `reviewer` agents with distinct angles generated from the actual target. Common angles are correctness/regressions, tests/validation, and simplicity/maintainability; adapt for TypeScript, UI, security, docs, or large structural changes. Reviewers should inspect files and diffs directly, return concise evidence-backed findings with file/line references, and avoid edits unless the user explicitly asks for a writer pass. The parent synthesizes fixes worth doing now, optional improvements, and feedback to ignore/defer before applying anything.

### Review-loop technique

Use this when the user wants implementation or current diff review to continue until reviewers stop finding fixes worth doing now. Keep the loop in the parent session: one `worker` implements or fixes, fresh-context `reviewer` agents inspect the actual repo and diff, the parent synthesizes accepted fixes, and one `worker` applies them. Prefer separate async reviewer runs so each completion wakes the parent instead of waiting for the whole panel. Continue useful parent work while they run; if none remains, end the turn and wait instead of polling. Do not put reviewer panels inside one async chain because the aggregate result hides individual reviewer completions; continue with explicit follow-up runs after each completion. Under an incomplete active Pi goal, set `async: false` for goal-critical implementation, review, and fix steps; a bounded foreground chain is acceptable only when the sequence is fixed and no parent decision is needed between steps. Treat an async implementation worker handoff as an intermediate state, not final completion, unless the user explicitly asked for worker-only work, review-only output, or to stop after implementation. Stop when reviewers find no blockers or fixes worth doing now, remaining feedback is optional or deferred, an unapproved product/scope/architecture decision appears, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. Do not loop for optional polish, and do not let children launch subagents or decide the loop outcome.

### Parallel research technique

Use this when the question needs both external evidence and local implications. Combine `researcher` for official docs, specs, ecosystem behavior, recent changes, benchmarks, and primary sources with `scout` for repository files, patterns, constraints, tests, and likely integration points. Give each child a distinct angle: external evidence, local code context, and practical tradeoffs. Ask for source links or file ranges, confidence level, gaps, and decision implications. Do not ask these children to edit unless implementation was explicitly requested.

### Parallel context-build technique

Use this before planning or implementation when a stronger handoff is needed. Run a chain with one parallel step of `context-builder` agents rather than top-level parallel tasks, so relative output files live under the temporary chain directory. Give every task a distinct output path such as `context-build/request-and-scope.md`, `context-build/codebase-and-patterns.md`, and `context-build/validation-and-risks.md`. Choose two or three builders: request/scope, codebase/patterns, and validation/risks. Each builder must read every relevant file needed to understand its slice, follow imports/callers/tests/docs/config, conduct tool-available web research when needed, and include a compact `meta-prompt` section. The parent synthesizes the outputs into important context, recommended next meta-prompt, open questions, assumptions, and artifact paths.

Example shape:

```typescript
subagent({
  chain: [{
    parallel: [
      { agent: "context-builder", task: "Build request/scope context for: ...", output: "context-build/request-and-scope.md" },
      { agent: "context-builder", task: "Build codebase/pattern context for: ...", output: "context-build/codebase-and-patterns.md" },
      { agent: "context-builder", task: "Build validation/risk context for: ...", output: "context-build/validation-and-risks.md" }
    ]
  }],
  context: "fresh"
})
```

### Parallel handoff-plan technique

Use this when the user needs a solution brief or implementation-ready handoff from an external reference plus local code context, such as “study this library behavior, inspect our codebase, then produce a worker prompt.” Run a chain with a first parallel group and a second synthesis `context-builder` step. The first group usually includes `researcher` for external projects/docs/prompt guidance and `context-builder` for local code context; add a second `context-builder` for implementation strategy only when the scope is large enough to benefit. Use distinct output paths under `handoff/`, then have the synthesis `context-builder` read those outputs and write `handoff/final-handoff-plan.md` with the recommended approach, likely files, constraints, non-goals, validation, risks, unresolved questions, and final compact implementation-ready meta-prompt.

Example shape:

```typescript
subagent({
  chain: [
    { parallel: [
      { agent: "researcher", task: "Research the external reference and transferable implementation ideas for: ...", output: "handoff/external-reference.md" },
      { agent: "context-builder", task: "Build local codebase context for: ...", output: "handoff/local-context.md" },
      { agent: "context-builder", task: "Compare evidence and propose implementation strategy for: ...", output: "handoff/implementation-strategy.md" }
    ] },
    { agent: "context-builder", task: "Read {previous} and synthesize the final handoff plan and implementation-ready meta-prompt.", output: "handoff/final-handoff-plan.md" }
  ],
  context: "fresh"
})
```

### Gather-context-and-clarify technique

Use this at the start of non-trivial work when material ambiguity remains. Launch `scout` for local context and `researcher` only when external docs, recent sources, ecosystem context, or primary evidence would materially improve understanding. Ask children for concise findings plus remaining clarification questions. Then synthesize what is known and use the available clarification tool (`ask_question` in pi) only for unresolved questions that affect scope, acceptance, constraints, or implementation.

### Parallel cleanup technique

Use this after implementation when the user wants cleanup review or when a final pass would reduce AI-slop. Launch two fresh-context `reviewer` tasks with `output: false` and `progress: false`: one deslop pass and one verbosity pass. If the `deslop` or `verbosity-cleaner` skills are available, pass the relevant skill to that reviewer; otherwise inline the criteria. Both reviewers are review-only and should flag concrete issues with severity, file/line references, and smallest safe fixes. Phrase the constraint as “Do not modify project/source files; returning findings through the configured output artifact is allowed” when you use `output` or `outputMode: "file-only"`. The parent decides what to apply and asks before making changes unless cleanup was already authorized.

### Staged fix orchestration technique

Use this when a broad diff has known reviewer findings across several items and the user wants the parent to “orchestrate subagents like a boss.” When an incomplete active Pi goal needs a fixed workflow to finish in the same turn, keep the active worktree safe with a foreground three-stage chain:

1. A parallel read-only planning fanout, one planner/reviewer per issue cluster. Each child inspects the real diff and returns exact files, line refs, proposed fixes, and focused validation. They must not edit.
2. One writer worker. It receives the planner summaries through `{previous}`, the parent’s accepted scope, stop rules, and verification contract. It is the only child allowed to edit the active worktree.
3. A parallel read-only validation fanout. Validators inspect the worker diff from fresh context with distinct angles, report pass/fail, remaining blockers, and missing verification.

Prefer `context: "fresh"` for planners/validators, `outputMode: "file-only"` for large summaries, and per-stage output names that will not collide. Keep the chain foreground; it is the incomplete-active-goal exception to separate async reviewer runs. Set `async: false`, and disable `forceTopLevelAsync` before using this pattern because that setting overrides explicit foreground requests. Outside an active goal, run the same stages under parent control: launch each planning or validation reviewer as a separate async single-agent run, synthesize after their individual completions, then launch the sole writer. Add `phase` and `label` to make foreground chain status readable, and use `as` plus `{outputs.name}` when a later step needs a specific earlier result instead of the whole `{previous}` blob. Use this pattern instead of launching several writer workers into a dirty worktree. Include non-blocking suggestions in the writer prompt only when they are small, safe, and do not expand product scope; otherwise record them as deferred.

When the first step can return a structured target list, prefer dynamic fanout instead of hand-authoring a static parallel group. Use `outputSchema` and `as` on the producer, then an `expand` step with `from: { output, path }`, an explicit `maxItems`, one `parallel` child template, and `collect.as`. Item templates may use `{item}` or a named item such as `{target.path}`. Do not use dynamic fanout for prose outputs, nested fanout, dynamic agent selection, reducers, `when` conditions, or arbitrary expressions; `.chain.md` does not support this syntax, so use direct JSON or a saved `.chain.json`.

Example shape:

```typescript
subagent({
  // Foreground active-goal exception; requires forceTopLevelAsync to be disabled.
  async: false,
  context: "fresh",
  chain: [
    { parallel: [
      { agent: "reviewer", phase: "Planning", label: "Deploy docs", as: "deployPlan", task: "Plan fixes for deploy docs/workflow. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/deploy.md", outputMode: "file-only" },
      { agent: "reviewer", phase: "Planning", label: "Scheduler contract", as: "schedulerPlan", task: "Plan fixes for scheduler contract. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/scheduler.md", outputMode: "file-only" },
      { agent: "reviewer", phase: "Planning", label: "Sandbox/security", as: "sandboxPlan", task: "Plan fixes for sandbox/security. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/sandbox.md", outputMode: "file-only" }
    ], concurrency: 3 },
    { agent: "worker", phase: "Implementation", label: "Apply accepted fixes", as: "workerResult", task: "Apply only the accepted fixes from these planning summaries. You are the sole writer for the active worktree.\n\nDeploy plan:\n{outputs.deployPlan}\n\nScheduler plan:\n{outputs.schedulerPlan}\n\nSandbox plan:\n{outputs.sandboxPlan}", acceptance: { criteria: ["Accepted fixes from each planning summary are applied", "Focused validation for changed behavior passes", "Changed files, validation commands, failures, and residual risks are reported"], evidence: ["changed-files", "commands-run", "validation-output", "residual-risks"], stopRules: ["Do not expand product scope beyond accepted fixes", "Stop and report if a fix requires an unapproved decision"], maxFinalizationTurns: 3 }, output: "worker/fixes.md", outputMode: "file-only", progress: true },
    { parallel: [
      { agent: "reviewer", phase: "Validation", label: "Deploy/scheduler validation", task: "Validate the post-worker diff for deploy and scheduler fixes. Start from the worker result: {outputs.workerResult}. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "validation/deploy-scheduler.md", outputMode: "file-only" },
      { agent: "reviewer", phase: "Validation", label: "Sandbox validation", task: "Validate the post-worker diff for sandbox/security fixes. Start from the worker result: {outputs.workerResult}. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "validation/sandbox.md", outputMode: "file-only" }
    ], concurrency: 2 }
  ]
})
```

## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents,
and user/project agents override builtins with the same name.

| Agent | Purpose | Primary model | Typical output / role |
|-------|---------|---------------|------------------------|
| `scout` | Fast codebase recon | `openai/gpt-5.6-sol` | Writes `context.md` handoff material |
| `context-builder` | Requirements/codebase handoff builder | `cloudflare-ai-gateway/claude-opus-5` | Writes structured context and meta-prompts |
| `researcher` | Evidence-driven technical research | `openai/gpt-5.6-sol` | Writes `research.md` |
| `watcher` | Read-only background monitoring | `openai/gpt-5.6-sol` | Queues the latest material transition; returns at the terminal condition |
| `planner` | Creates implementation plans | `cloudflare-ai-gateway/claude-opus-5` | Writes `plan.md` |
| `worker` | Bounded implementation | `openai/gpt-5.6-sol` | Single-writer implementation and validation |
| `debugger` | Root-cause diagnosis | `cloudflare-ai-gateway/claude-opus-5` | Writes `diagnosis.md` |
| `fixer` | Decided, bounded remediation | `cloudflare-ai-gateway/claude-opus-5` | Applies an explicit fix list |
| `reviewer` | General implementation review | `cloudflare-ai-gateway/claude-opus-5` | Review-only by default |
| `reviewer-gpt` | Strict completion gate | `openai/gpt-5.6-sol` | Maintainability/correctness review |
| `reviewer-claude` | Cross-model product-risk review | `cloudflare-ai-gateway/claude-fable-5` | Independent review |
| `reviewer-security` | Trust-boundary review | `fireworks/accounts/fireworks/routers/kimi-k3-fast` | Security/data-safety findings |
| `reviewer-ponytail` | Over-engineering and slop review | `fireworks/accounts/fireworks/routers/kimi-k3-fast` | Deletion-focused findings; behavior-preserving only |
| `ui-designer` | UI and accessibility review | `cloudflare-ai-gateway/claude-opus-5` | Rendered UX guidance |
| `writer` | Human-facing writing | `cloudflare-ai-gateway/claude-fable-5` | Writes `draft.md` |
| `oracle` | Decision-consistency advisory review | `openai/gpt-5.6-sol` | Forked advisory review |
| `delegate` | Lightweight generic delegate | inherits default | No fixed output; generic delegated work |

The Fitch role profiles pin primary and fallback routes; `delegate` inherits the current Pi model. Keep those configured defaults unless a run, user setting, or project setting has a concrete reason to override them.

For one run, use inline config:

```text
/run reviewer[model=anthropic/claude-sonnet-4] "Review this diff"
```

For persistent tweaks, edit `subagents.agentOverrides` in user or project settings. User overrides apply everywhere. Project overrides apply only in that repo and win over user overrides.

## Prompting role subagents

When launching role agents, keep their configured model routes and write the task prompt as a compact contract, not a long procedural script. Define the destination and let the role choose the efficient path.

A strong subagent prompt usually includes:
- **Goal**: the concrete outcome the child should produce.
- **Context/evidence**: relevant plan paths, files, diffs, decisions, or user constraints already approved.
- **Success criteria**: what must be true before the child can finish.
- **Hard constraints**: true invariants only, such as no edits for review-only tasks, one writer thread, child must not run subagents unless it is an explicitly assigned `allowSubagents: true` or `tools: subagent` fanout child, or escalation for unapproved decisions.
- **Validation**: targeted checks to run, or the next-best check when validation is impossible.
- **Output**: the expected summary shape, artifact path, or finding format.
- **Stop rules**: when to ask via `intercom`, when to stop after enough evidence, and when not to keep searching.

Avoid carrying over old prompt habits that over-specify every step. Use `must`, `always`, and `never` for real invariants; for judgment calls, give decision rules. For example, tell a reviewer to inspect the staged diff directly and report only evidence-backed findings, rather than prescribing every file or command. Tell a researcher the retrieval budget: start with broad targeted searches, fetch only the strongest sources, search again only when a required fact is missing, then stop.

For implementation handoffs, name the approved scope and success criteria more clearly than the process. Good prompts say what to change, what not to change, where the evidence lives, how to validate, and when to escalate. They should not ask the child to create another subagent plan or continue the parent conversation.

Settings locations:
- User scope: `~/.pi/agent/settings.json`
- Project scope: `.pi/settings.json`

Direct settings example:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

Useful override fields: `model`, `fallbackModels`, `thinking`,
`systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`,
`disabled`, `skills`, `tools`, and `systemPrompt`. Create a user or project
agent with the same name only when you want a substantially different agent.

## Discovery and Scope Rules

Agent files can live in:
- `~/.pi/agent/agents/**/*.md` — user scope
- `.pi/agents/**/*.md` — canonical project scope
- legacy `.agents/**/*.md` — still read for compatibility, but `.pi/agents/` wins on conflicts

Chains live in:
- `~/.pi/agent/chains/**/*.chain.md` and `~/.pi/agent/chains/**/*.chain.json` — user scope
- `.pi/chains/**/*.chain.md` and `.pi/chains/**/*.chain.json` — project scope

Discovery is recursive. `.chain.md` files do not define agents. Use `.chain.md` for simple saved chains and `.chain.json` for dynamic fanout or inline schema objects. Agents and chains can set optional frontmatter/package metadata; `name: scout` plus `package: code-analysis` registers as runtime name `code-analysis.scout` while serialization keeps `name` and `package` separate.

Precedence is by parsed runtime name:
1. project scope
2. user scope
3. builtin agents

## Running Subagents

### Single agent

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions."
})
```

### Forked context

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions."
})
```

`context: "fork"` creates a branched child session from the current persisted
parent session. It does **not** create a fresh minimal review context or filter
history down to only the relevant parts. Use it when you want a separate review
or execution thread that can still reference the parent session history. Fork
is rejected when an affected agent's effective primary or fallback model uses
the `anthropic/` provider; explicit context/model overrides cannot bypass this
restriction.

### Parallel execution

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Explore the auth module" },
    { agent: "researcher", task: "Research API client retry behavior" }
  ]
})
```

Top-level parallel tasks can override per-task behavior:

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Map auth", output: "auth-context.md", progress: true },
    { agent: "researcher", task: "Research OAuth best practices", output: "oauth-research.md" },
    { agent: "scout", task: "Map auth test coverage", model: "anthropic/claude-sonnet-4" }
  ],
  concurrency: 3
})
```

Avoid duplicate explicit output paths in parallel tasks. Concurrent children should not be told to write the same explicit file. Explicit output paths persist at their resolved cwd/workspace path; relative output paths that come from agent defaults are automatically materialized under the run artifact directory with unique names, so default `context.md`/`review.md` handoffs do not collide or leave project-root files. For large saved outputs, set `outputMode: "file-only"` together with an `output` path. The parent result then contains only a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` instead of the full saved content. Do not use `output: false` for this; `output: false` means no file output. When a task is review-only, say “do not modify project/source files” rather than “do not write files” if you also configured `output`; otherwise the child may treat the output artifact as forbidden. Failed runs and save errors still return inline details for debugging.

### Chain execution

```typescript
subagent({
  chain: [
    { agent: "scout", task: "Map the auth flow and summarize key files" },
    { agent: "planner", task: "Create an implementation plan from {previous}" },
    { agent: "worker", task: "Implement the approved plan based on {previous}" }
  ]
})
```

Chain steps can use templated variables such as `{task}`, `{previous}`,
`{chain_dir}`, and `{outputs.name}`. Use `as: "name"` on a successful step or
parallel task to make that output available to later steps. Prefer named outputs
when a later step needs one specific result; keep `{previous}` for simple linear
handoffs or full fan-in summaries. Use `phase` and `label` for status readability.
Use `outputSchema` when later steps need reliable structured data; the child must
call `structured_output` with schema-valid JSON, or the step fails.

### Async/background

Subagent launches default to async mode when `async` is omitted. Use that default for scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, chains, and non-review parallel groups. Launch each member of a reviewer or validator panel as a separate single-agent call; do not put the panel in one parallel group or chain. Keep the write path single-threaded even when the run is async.

Active goal exception: when a Codex-style Pi goal is active and incomplete, set `async: false` for work that must finish before the next goal step. Goal prompting can continue after a parent turn ends, so omission is unsafe for that narrow dependency. Keep the async default when the parent has concrete independent work or can end its turn and wait safely.

Async does not mean parallel writes. Do not edit the same active worktree while an async worker is changing it. Parent-side overlap should be reading, validation prep, synthesis, command planning, or review of unaffected context unless the writer is isolated in a separate worktree.

After launching an async child, continue promised or useful independent work. If none remains, end your turn and wait instead of sleep-polling; Pi will deliver the completion. Set `async: false` when an incomplete active goal needs the child evidence before its next step.

Reviewer sign-off exception: a reviewer timeout is never sign-off. Prefer separate default-async runs for final reviewers outside active goal loops so each completion wakes the parent. When an incomplete active goal needs same-turn reviewer evidence, set `async: false` without `timeoutMs`. Runtime automatically raises foreground reviewer timeouts below 15 minutes to prevent false non-signoff failures. Planner/researcher-style roles raise short foreground budgets only when local run history shows they need longer; async/background runs still reject foreground timeout fields. Do not use short foreground timeouts such as 3–4 minutes for broad reviewer/scout/research tasks. If a reviewer times out, resume, rerun with enough budget, or split the review into narrower reviewers before claiming reviewed completion.

```typescript
subagent({
  agent: "worker",
  task: "Run the full test suite"
})
```

For changing external state, give `watcher` the target, material transitions, and terminal condition. It suppresses unchanged observations and queues the latest non-terminal material change through the deferred, coalesced supervisor bridge. Pending updates may replace one another; the terminal async completion is what wakes the parent.

```typescript
subagent({
  agent: "watcher",
  task: "Watch GitHub Actions for PR #123. Treat status changes, failures, and recoveries as material. Stop when every check is terminal."
})
```

File-only output mode also works for async single runs, top-level parallel task items, sequential chain steps, and chain parallel task items. In chains, `{previous}` receives the compact saved-file reference when the prior step used file-only mode.

For review fanout where the parent continues a local audit:

```typescript
const run = subagent({
  agent: "reviewer",
  task: "Review the current diff for correctness issues. Do not edit files.",
  context: "fresh"
})
// Continue local inspection; completion will wake the parent.
```

Inspect async runs with `subagent({ action: "status", id: "..." })` or `subagent({ action: "status" })` for active runs. Use status for diagnostics, not as a wait loop; healthy runs deliver completion automatically. After a foreground run completes or times out, `status` can still show the remembered foreground children and revive command by id, or with `subagent({ action: "status", id: "latest" })` / `id: "last"` for the latest remembered foreground run in the current session. If a delegated fanout child launches nested runs, the parent status view shows them as a tree and you can target a nested run directly with its nested id.

Use `extend` when an active foreground child has an explicit timeout and is still doing useful work:

```typescript
subagent({ action: "extend", id: "foreground-run-id", extendMs: 300000 })
```

`extend` adds time to the current foreground child deadline. It does not revive an already timed-out child; use `resume` after a timeout or transient failure.

Use `resume` for follow-up work after a delegated run:

```typescript
subagent({ action: "resume", id: "run-id", message: "Follow up on this point." })
subagent({ action: "resume", id: "run-id", index: 1, message: "Continue reviewer 2." })
subagent({ action: "resume", id: "nested-run-id", message: "Continue this nested reviewer." })
```

Resume behavior:
- If an async child is still running and reachable, `resume` sends the follow-up to that live child over intercom.
- If a live foreground or async child needs a prompt but not a blocking reply, `nudge` sends a steered intercom message through the same bridge.
- If an async child has completed, `resume` revives it by starting a new async child from the persisted child session file.
- Multi-child async runs require `index` unless only one running child is selectable.
- Completed foreground single, parallel, and chain runs can also be revived by `index` while their run metadata remains in extension state.
- Timed-out or transient-error foreground children can be revived the same way when their `.jsonl` session file was persisted.
- Nested runs can be resumed by nested id when a live route or persisted nested session metadata is available.
- Revive starts a new child process from the old session context; it does not restart the same OS process.
- If the chosen child has no persisted `.jsonl` session file, resume fails and reports that directly.

Use diagnostics when setup or child startup looks wrong:

```typescript
subagent({ action: "doctor" })
```

Humans can use `/subagents-doctor` for the same read-only report. It checks runtime paths, discovery counts, async support, current session context, and intercom bridge state.

### Subagent control

Subagent control is the runtime visibility and intervention layer for delegated runs. It is separate from lifecycle status. Lifecycle status says whether a child is `queued`, `running`, `paused`, `complete`, or `failed`. Activity reporting is factual: it tracks the last observed activity time and the current tool when known. It does not pretend to know that a child is truly stuck.

Default behavior is intentionally conservative. When no activity has been observed past the configured threshold (10 minutes by default), the run emits a `needs_attention` control event. Foreground runs can push this as a `subagent:control-event` event, and async runs persist it to `events.jsonl` so the parent tracker can surface it without constant manual polling. Notification-worthy control events are also inserted into the visible transcript so both the user and the parent agent can see them, with a proactive hint plus concrete `nudge`, `status`, and `interrupt` options. Use `status` to see an `extend` command when the active foreground child has an extendable timeout. Visible notifications fire once per child run and attention state.

Use soft interrupt when a child is clearly blocked or drifting and the parent needs to regain control:

```typescript
subagent({ action: "interrupt" })
```

Pass `id` when targeting a specific controllable run, including a nested run shown in the parent status tree:

```typescript
subagent({ action: "interrupt", id: "abc123" })
subagent({ action: "interrupt", id: "nested-run-id" })
```

A soft interrupt cancels the current child turn and leaves the run paused. It does not mean the delegated task succeeded or failed. Bare `interrupt` does not target hidden nested descendants; use the explicit nested id. After an interrupt, decide the next explicit action: resume with clearer instructions, replace the task, ask the user, or stop the workflow.

Per-run control thresholds can be overridden when a task legitimately runs without observable output for longer than usual:

```typescript
subagent({
  agent: "worker",
  task: "Run the slow migration test suite",
  control: {
    needsAttentionAfterMs: 1800000,
    notifyOn: ["needs_attention"]
  }
})
```

Needs-attention notifications can also prepare a compact intercom ping for the paired orchestrator target. Prefer `subagent({ action: "nudge", id: "...", message: "..." })` for live guidance, answers, corrections, or blockers; it is a non-blocking steer that supplements the active child task unless it explicitly replaces it. Use the status-shown intercom ask only when the parent must remain alive waiting for a reply. Do not invent a target; use the resolved target shown in status or injected instructions. An explicit agent `extensions` allowlist that omits `pi-intercom` still sandboxes child-side coordination tools.

## Clarify TUI

Single and parallel runs support a clarification TUI when you want to preview or
edit parameters before launch:

```typescript
subagent({
  agent: "worker",
  task: "Implement feature X",
  clarify: true
})
```

Clarify is opt-in for tool calls. Set `clarify: true` when you want to preview or edit a single, parallel, or chain run before launch. Clarify edits affect only the next run; use management actions, settings, or markdown files for persistent changes.
Programmatic launches run in the background by default. Omit `clarify` or set `clarify: false` to launch directly; `async: false`, `clarify: true`, or a foreground timeout keeps the run foreground.


## Worktree Isolation

When multiple agents might write concurrently, use worktrees instead of letting
them share one filesystem view.

```typescript
subagent({
  tasks: [
    { agent: "worker", task: "Implement feature A" },
    { agent: "worker", task: "Implement feature B" }
  ],
  worktree: true
})
```

`worktree: true` gives each parallel task its own git worktree branched from
HEAD. This requires a clean git state and is mainly for intentionally parallel
write workflows. If you want one writer thread and several advisory agents,
prefer a single-writer pattern instead.

## The Oracle Workflow

The intended oracle loop is:
1. the main agent forks to `oracle`
2. `oracle` reviews direction, drift, assumptions, and risks
3. `oracle` can coordinate back through `contact_supervisor` when the bridge injects it
4. the main agent decides what direction to approve
5. only then should `worker` implement

```typescript
// Advisory review in a branched thread. Oracle defaults to forked context.
subagent({
  agent: "oracle",
  task: "Review my current direction, challenge assumptions, and propose the best next move."
})

// Implementation only after explicit approval. Worker defaults to fresh context.
subagent({
  agent: "worker",
  task: "Implement the approved approach: ..."
})
```

`oracle` is not a fresh-context reviewer in the Cognition article sense. It is
a forked advisory thread that inherits the parent session history and uses that
history as a baseline contract.

Use `oracle` as a smart-friend escalation when the parent needs help with trajectory rather than diff inspection: architectural boundaries, model capability routing, merge conflicts, reviewer disagreement, context drift after long work, a worker about to invent a pattern, or fixes that require product/scope tradeoffs. Ask broad questions when the right concern is unclear, and let `oracle` point out missing context or files the parent should inspect before asking again. Keep `oracle` advisory unless it has been explicitly assigned the single writer role.

## Subagent + Intercom Coordination

`pi-subagents` bundles its intercom extension. Children get fixed default bridge instructions and a private coordination channel back to the parent session unless an explicit `extensions` allowlist omits `pi-intercom`.

Most agents should not call generic `intercom` directly unless bridge instructions provide a target and `contact_supervisor` is unavailable. Do not invent a target. Prefer the tool from the injected bridge instructions.

Use blocking `contact_supervisor` only when an ephemeral child cannot safely continue and must remain alive for the reply:
- `reason: "need_decision"` for one decision, approval, or product/API/scope clarification
- `reason: "interview_request"` when multiple structured answers are all required before safe progress

Both reasons steer the supervisor at its next tool boundary.

Do not use `contact_supervisor` just to resolve review-only/no-project-edit versus progress-writing or output-artifact instructions. The child must not modify project/source files, but returning findings through its normal response or configured output artifact is allowed unless the parent explicitly set `output: false`.

Use `contact_supervisor` with `reason: "progress_update"` only for a concise material update that may intentionally wait behind active supervisor work. It is non-blocking and uses deferred, replace-mode delivery so newer updates can coalesce older undelivered ones.

Message conventions:
- `reason: "need_decision"` and `reason: "interview_request"` steer, wait for the parent reply, and return it to the child.
- `reason: "progress_update"` is intentionally deferred and should stay concise.
- Child-side routine completion handoffs are not expected. Parent-side `pi-subagents` sends grouped completion results through `pi-intercom`: one grouped message per foreground parent run and one per completed async result file. Acknowledged foreground delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved. Grouped messages include child intercom targets, full child summaries, and compact nested summaries under the parent child that launched them.

If bridge instructions provide the child-facing tool, a child can ask:

```typescript
contact_supervisor({
  reason: "need_decision",
  message: "The approved API contract does not specify whether this new response field may be public. Should I preserve the current response shape?"
})
```

The parent replies with:

```typescript
intercom({ action: "reply", message: "Optimize for readability." })
```

Or inspects unresolved asks first:

```typescript
intercom({ action: "pending" })
```

If intercom messages do not show up, run `subagent({ action: "doctor" })` or `/subagents-doctor`.

## Management Mode

The `subagent(...)` tool also supports management actions.

### List available agents and chains

```typescript
subagent({ action: "list" })
```

`list` and `get` show the effective runtime agent by default. If a user or project agent shadows a builtin with the same name, the agent appears once with the same precedence used for execution (`project` > `user` > `builtin`). Use `agentScope: "user"` or `agentScope: "project"` only when you need to inspect a specific shadowing scope.

### Create an agent

```typescript
subagent({
  action: "create",
  config: {
    name: "my-agent",
    package: "code-analysis",
    description: "Project-specific implementation helper",
    systemPrompt: "Your system prompt here.",
    systemPromptMode: "replace",
    model: "openai-codex/gpt-5.4",
    tools: "read,grep,find,ls,bash"
  }
})
```

### Update an agent

```typescript
subagent({
  action: "update",
  agent: "code-analysis.my-agent",
  config: {
    thinking: "high"
  }
})
```

### Delete an agent

```typescript
subagent({ action: "delete", agent: "code-analysis.my-agent" })
```

Use management actions when the system needs to create or edit subagents on
demand without dropping into raw file editing.

Management actions create or update user/project agent files. `config.name` is the local frontmatter name; optional `config.package` registers and looks up the runtime name as `{package}.{name}`. Use the dotted runtime name for `get`, `update`, `delete`, slash commands, and chain steps. `get` follows effective runtime precedence by default; `update` and `delete` use `agentScope` only when the same runtime name exists in multiple mutable scopes. For small builtin changes such as a model swap, prefer `subagents.agentOverrides` in settings.

## Creating and Editing Agents by File

A minimal agent file looks like this:

```markdown
---
name: my-agent
package: code-analysis
description: What this agent does
model: openai-codex/gpt-5.4
thinking: high
tools: read, grep, find, ls, bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Your system prompt here.
```

That is only a starting point. Omit `package` for the traditional unqualified runtime name. Common optional fields include:
- `defaultProgress`
- `defaultReads`
- `output`
- `fallbackModels`
- `maxSubagentDepth`

For many customizations, builtin overrides in settings are lower-friction than
copying a full builtin file.

## Prompt Template Integration

The files under `prompts/` are unregistered examples of common workflows. Parent agents can apply the same recipes directly with `subagent(...)` when the user describes the workflow in natural language.

If `pi-prompt-template-model` is installed, additional user prompt templates can delegate into
`pi-subagents`. This is useful when a slash command should always run through a
particular agent or with forked context.

## Important Constraints

- **Forking requires a persisted parent session.** If the current session does not
  have a persisted session file, forked runs fail. Packaged `oracle` defaults to
  forked context; the other Fitch role profiles default to fresh context.
- **Forked runs inherit parent history.** They are branched threads, not fresh
  filtered contexts. Use fresh context for adversarial reviewers unless the user explicitly asks for forked context.
- **Default subagent nesting depth is 2.** Deeper recursive delegation is blocked
  unless configured otherwise.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `paused` means the child turn was intentionally interrupted or is awaiting direction; it is not the same as `failed`.
- **Intercom asks are blocking.** A session can only maintain one pending outbound
  ask wait state at a time.
- **Keep conversational authority clear.** Advisory subagents should not silently
  become second decision-makers.

## Best Practices

### Prefer async orchestration

Launch independent subagents with the default async mode. Omit `async` for scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, chains, and non-review parallel groups. Launch reviewer and validator panels as separate single-agent calls, not one parallel group or chain. Continue useful parent work while children run; if none remains, end the turn and wait for automatic completion instead of polling.

When an active Pi goal is incomplete, set `async: false` only for goal-critical child work that must finish before the next step. Keep the default async mode for independent overlap or when the parent can end its turn and wait safely.

For reviewer sign-off, avoid short foreground timeouts. A timeout means review incomplete, not review failed cleanly and not sign-off. Prefer separate async runs outside active goal loops; set `async: false` with no short `timeoutMs`/`maxRuntimeMs` when an incomplete active goal needs same-turn evidence.

### Keep writes single-threaded by default

A strong pattern is one main decision-maker plus advisory/research/review/validation subagents around it. Use `oracle` for advice and `worker` for the actual write path. Parallelize reading, review, validation, and synthesis support, not normal writes, unless you deliberately isolate writers with worktrees. A child that writes should report what changed, what was left undone, commands run with exit codes, validation evidence, surprises, and any decisions that need parent approval.

### Use fork for branched advisory or execution threads

Forked runs are useful when the child should reason in a separate thread while
still inheriting the parent’s accumulated context. They are especially useful for
`oracle`, which audits inherited decisions and drift. For adversarial code review,
prefer fresh-context reviewers that inspect the repo and diff directly unless the
user explicitly requests forked context.

### Prefer narrow tasks

Give subagents specific tasks rather than vague mandates.
`Review auth.ts for null-check gaps` works better than `Review everything`.

### Escalate decisions upward

If a subagent encounters an unapproved product, architecture, or scope choice,
it should coordinate back via `intercom` instead of deciding alone.

### Intervene only on clear control signals

Use subagent control proactively when a delegated run emits `needs_attention`, or when a human asks you to regain control. Do not interrupt just because a child has briefly produced no output. Silence can be normal during long tool calls, test runs, or model reasoning.

### Name sessions meaningfully

Use `/name` so intercom targeting stays stable.

## Common Workflows

### Recon → Plan → Implement

```typescript
subagent({
  chain: [
    { agent: "scout", task: "Map the auth flow and summarize relevant files" },
    { agent: "planner", task: "Plan the migration from {previous}" },
    { agent: "worker", task: "Implement the approved plan from {previous}" }
  ]
})
```

### Clarify → Plan → Implement → Review (self-orchestrated workflow)

When you are the orchestrating agent for a new feature or non-trivial change, use the same orchestration patterns through tools and subagents.

Keep effective agent defaults for routine runs. User/project agent descriptions and frontmatter may encode when to override model, thinking level, skills, output behavior, or context mode; follow that policy when risk warrants it, but do not add overrides just because you are orchestrating. Packaged `oracle` defaults to forked context; the other Fitch role profiles default to fresh context. Fork is never available to effective `anthropic/` primary or fallback models; other providers continue to use the configured context policy normally.

When the user approves launching a subagent to carry out a plan or workflow, treat that as approval to generate a proper role-specific meta prompt for that subagent. Include the approved plan path or summary, clarified requirements, non-goals, relevant context, role boundaries, files or areas to inspect, acceptance criteria, expected output, and validation expectations. Do not pass vague instructions like “implement the plan fully” or “review this” by themselves.

- Gather context and clarify: launch `scout` and, when needed, `researcher`; synthesize findings; then use the available clarification tool (`ask_question` in pi) for unresolved material questions.
- Parallel review: launch fresh-context `reviewer` agents with distinct review angles; synthesize the feedback before applying anything.
- Review loop: keep the parent in charge of worker → fresh reviewers → synthesized fix worker cycles until no fixes worth doing now remain, an unapproved decision appears, or the review-round cap is reached.
- Parallel research: combine local `scout` context with external `researcher` evidence when current docs, ecosystem behavior, or API details matter.
- Parallel context build: run a chain-mode parallel group of `context-builder` agents with distinct temp output paths, then synthesize their context and meta-prompt sections.
- Parallel handoff plan: run external `researcher` plus local/strategy `context-builder` passes, then a synthesis `context-builder` that writes an implementation handoff plan and implementation-ready meta-prompt.
- Parallel cleanup: use review-only cleanup passes after implementation, especially for simplicity, verbosity, and redundant tests.

For feature work, use this sequence as scaffolding for parent-agent behavior:

```text
clarify → validation contract → planner → worker → fresh-context reviewers/validators → fix worker → follow-up review when warranted → parent review
```

The validation contract defines acceptance before code is written: expected behavior, acceptance checks, commands or user flows to exercise, and evidence the worker should return. Keep it lightweight for small tasks, but make it explicit enough that reviewers and validators are checking the intended outcome rather than the worker’s own assumptions.

Use the structured `acceptance` field when the run should carry an explicit acceptance contract. If omitted, the run stays lightweight. For review-only tasks, omit it unless the user explicitly requests a same-session acceptance contract; the extra finalization turn is not independent review. When present, acceptance is object-only: define concrete `criteria`, required `evidence`, optional runtime `verify` commands, and optionally `maxFinalizationTurns`. The runtime continues the same child session for a bounded self-review/repair loop before evaluating the final report, so set `acceptance` on single runs, sequential chain steps, parallel task items, and dynamic fanout child templates, not on static parallel or dynamic fanout groups. Independent review stays parent-controlled: `acceptance.review` is unsupported and fails preflight, so launch reviewer subagents separately after the worker completes. Child-reported command success is evidence, not runtime verification.

Goal-style requests map to `acceptance`. If the user says `/goal`, “goal”, “active goal”, “continue until evidence says done”, or “verify against a goal” for a subagent run, create an explicit run-scoped acceptance contract: `criteria` for the target, `evidence` and `verify` for proof, `stopRules` for constraints, and `maxFinalizationTurns` for the bounded loop budget.

When launching a writer/worker from a plan, PRD, spec, issue, or broad fix, set structured `acceptance` proactively. Put implementation instructions, plan paths, and handoff artifacts in `task`; put the definition of done in `acceptance.criteria`, proof requirements in `acceptance.evidence` and `acceptance.verify`, constraints in `acceptance.stopRules`, and usually set `maxFinalizationTurns: 3`. Do not bury all validation requirements only in the task prompt.

Example writer handoff:

```typescript
subagent({
  agent: "worker",
  // Async is the default; set async: false only when this result must arrive in the same turn.
  task: "Implement the plan at /Users/me/docs/mcp-alignment-plan.md. Use scout artifacts in ./handoff/ as context. Do not commit the scout artifacts.",
  acceptance: {
    criteria: [
      "Implementation follows /Users/me/docs/mcp-alignment-plan.md",
      "Plan acceptance checks are addressed",
      "Scout handoff artifacts are not committed",
      "Focused validation for changed behavior passes",
      "Residual risks or skipped checks are reported"
    ],
    evidence: ["changed-files", "commands-run", "validation-output", "residual-risks"],
    verify: [{ id: "focused", command: "npm test -- --runInBand" }],
    stopRules: [
      "Do not edit unrelated files",
      "Stop and report if the plan requires an unapproved product decision"
    ],
    maxFinalizationTurns: 3
  }
})
```

The first `worker` implements the approved plan. The parent continues with independent inspection or validation prep while it runs only when the worker is async; do not make parallel edits to the same worktree. When an async worker completes, treat its handoff as the transition into review, not as final completion, unless the user explicitly asked for worker-only work, review-only output, or to stop after implementation. Launch parallel reviewers as separate async runs so each completion wakes the parent. Validators check behavior with the best available evidence: commands, tests, browser/CLI interaction, screenshots, logs, or manual reproduction notes. The final `worker` applies synthesized review fixes, then the parent looks over the final diff before completing. Keep these as parent-launched follow-up runs after each completion; do not hide reviewer panels inside an initial async chain. Under an incomplete active Pi goal, a fixed sequence with no intervening parent decision may instead use a bounded foreground chain. Do not stop after parallel review unless the user explicitly asked for review-only output or the review surfaced a decision that needs approval first.

For complex work, risky changes, broad refactors, or many changed lines, increase review and validation fanout rather than trusting one reviewer. Use distinct angles such as correctness/regressions, tests/validation, simplicity/maintainability, security/privacy, performance, docs/API contracts, and user-flow behavior. When reviewers find non-trivial issues or the fix worker touches many lines, run another focused review round before final validation.

When review has already produced concrete findings across several independent areas, use staged fix orchestration: parallel read-only planners for each issue cluster, one sole writer worker for the active worktree, then parallel fresh-context validators. This is the safest way to handle a dirty worktree with many prior changes because it parallelizes judgment without parallelizing writes. Non-blocking suggestions may go into the writer prompt only if they are small, safe, and inside the approved scope; otherwise defer them explicitly.

For very large work, split into serial milestones instead of launching a swarm of writers. Each milestone gets one writer, a validation contract, fresh-context review/validation, a fix pass, and parent acceptance before the next milestone starts. Use parallel subagents inside a milestone for read-only context, research, review, and validation only.

Keep orchestration authority in the parent session. Child subagents should not launch more subagents, read this skill, or run their own orchestration loops unless the parent intentionally selected a fanout agent with `allowSubagents: true` or builtin `tools` including `subagent`. Child-safe nested calls default to foreground so their evidence returns in the calling child's report; use `async: true` there only for intentionally detached work whose result the child does not need to return. Spawned subagents do not receive the `pi-subagents` skill, parent-only status/control/slash messages, or prior parent `subagent` tool-call/tool-result artifacts. Ordinary children also do not receive the `subagent` extension tool. Child context filtering strips old hidden orchestration-instruction messages when they appear in inherited history. Every child receives a boundary instruction: ordinary children are told the parent owns orchestration and they must not propose or run subagents; explicit fanout children are told to use `subagent` only for the assigned fanout work, with `maxSubagentDepth` still enforced. Implementation children must call real edit/write tools instead of printing pseudo tool calls. Pass children concrete role-specific work instead.

1. Clarify only material uncertainty. Gather code context with `scout` or `context-builder`, add `researcher` only when external evidence matters, then ask the user unresolved questions with the available clarification tool (`ask_question` in pi) when the answer changes scope, acceptance criteria, constraints, or non-goals.
2. Define the validation contract. State acceptance before implementation: expected behavior, checks to run, user flows to exercise, and evidence required in the worker handoff. For UI, CLI, integration, or workflow changes, include at least one validator angle that uses the product the way a user would rather than only reading code.
3. Plan when useful. For complex work, call `planner` or write a plan doc yourself and get approval before implementation. For simple work, confirm shared understanding and explicitly note why planning is skipped.
4. Implement with one writer. After approval, launch `worker` asynchronously with a proper meta prompt that includes clarified requirements, relevant context, plan path or summary, the validation contract, and output expectations; under an incomplete active Pi goal, set `async: false` for goal-critical writer work. Packaged `worker` defaults to fresh context. While an async worker runs, prepare validation or inspect adjacent code instead of editing the same worktree.
5. Require a useful worker handoff. Ask the worker to report changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises or new risks, decisions made inside approved scope, and decisions needing parent approval.
6. Review after implementation. After the worker completes, launch fresh-context `reviewer` agents for correctness/regressions, tests/validation, and simplicity/maintainability as separate async runs so each completion wakes the parent. Under an incomplete active Pi goal, set `async: false` when review gates the next goal step. Add security, performance, docs/API, domain-specific, or user-flow validators for complex work, risky changes, broad refactors, or many changed lines. Use `output: false` unless review artifacts are explicitly needed.
7. Synthesize, then run the fix worker. Separate blockers, fixes worth doing now, optional improvements, and feedback to ignore/defer, then launch an async `worker` to apply fixes worth doing now when the workflow is implementation-authorized. Set `async: false` when an incomplete active Pi goal needs the fix result in the same turn. If reviewers found scope/product/architecture choices that were not approved, ask the user first instead of applying them.
8. Review again when warranted. If the fix worker made substantial changes or addressed non-trivial findings, run another focused parallel review round before final validation.
9. Validate and complete. After the fix worker and any follow-up review return, inspect the final diff yourself, run or confirm focused validation, update docs/changelog when relevant, and summarize what changed and why.

Example implementation handoff after clarification and optional planning:

```typescript
subagent({
  agent: "worker",
  task: "Implement the approved feature.\n\nClarified requirements:\n- ...\n\nPlan: see ~/Documents/docs/...-plan.md\n\nValidation contract:\n- ...\n\nReturn a handoff with changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises/new risks, and decisions needing parent approval.",
  acceptance: {
    criteria: ["Implement the approved feature without widening scope"],
    evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"],
    maxFinalizationTurns: 3
  }
  // Async is the default; set async: false only when this result must arrive in the same turn.
})
```

Example review pass after implementation, outside an active goal loop:

```typescript
subagent({ agent: "reviewer", task: "Review the current diff for correctness and regressions. Inspect changed files directly; do not rely on the worker's reasoning.", context: "fresh", output: false })
subagent({ agent: "reviewer", task: "Review the current diff for tests and validation quality against the validation contract. Inspect changed files directly.", context: "fresh", output: false })
subagent({ agent: "reviewer", task: "Review the current diff for simplicity and maintainability. Inspect changed files directly.", context: "fresh", output: false })
// Each completion wakes the parent. Continue useful work or end the turn and wait; do not poll.
```

Example fix worker after parallel reviews:

```typescript
subagent({
  agent: "worker",
  task: "Apply the synthesized reviewer feedback below. Only apply fixes worth doing now; preserve user-approved scope; ask before unapproved product or architecture changes. Run focused validation and summarize what changed.\n\nReviewer synthesis:\n..."
  // Async is the default; set async: false only when this result must arrive in the same turn.
})
```

### Review loop

Do not treat review as the final step for implementation work. Run reviewers and validators, synthesize their findings against user scope and the validation contract, then launch one `worker` for accepted fixes when implementation is authorized.

When an async implementation worker completes, treat the worker handoff as an intermediate state. The next parent action is separate async review runs, then synthesis, then an async fix worker if reviewers found fixes worth doing now. Keep these as parent-launched follow-up runs so each reviewer completion wakes the parent; do not put the review panel inside one async chain. Under an incomplete active Pi goal, set `async: false` for goal-critical steps instead.

For explicit review-loop requests, repeat worker → fresh-reviewer → synthesized-fix-worker cycles until reviewers find no blockers or fixes worth doing now, remaining feedback is optional or intentionally deferred, an unapproved product/scope/architecture decision needs the user, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. For complex work, many changed lines, or any fix pass that materially changes the diff, run another focused review round before the parent’s final look; otherwise stop instead of chasing optional polish.

### Parallel non-conflicting analysis

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Audit frontend auth flow" },
    { agent: "researcher", task: "Research current retry/backoff best practices" }
  ]
})
```

### Saved chain

```text
/run-chain review-chain -- review this branch
```

Use saved `.chain.md` or `.chain.json` workflows when the user wants a repeatable multi-agent flow without rewriting the chain each time. Prefer `.chain.json` for dynamic fanout or inline `outputSchema` objects; `.chain.md` remains the simple sequential/static authoring format.

## Error Handling

**"Unknown agent"**
```typescript
subagent({ action: "list" })
// Check available agents and chains, then confirm scope/precedence.
```

**Setup, discovery, or intercom confusion**
```typescript
subagent({ action: "doctor" })
// Check runtime paths, async support, discovery counts, current session, and intercom bridge state.
```

**"Max subagent depth exceeded"**
```typescript
// Flatten the workflow or raise maxSubagentDepth in config.
```

**"Session manager did not return a session file"**
```typescript
// Persist the current session before using context: "fork".
```

**Intercom "Already waiting for a reply"**
```typescript
// Resolve the current outbound ask before starting another one.
```

**Parallel output-path conflict**
```typescript
// Give each parallel task a distinct output path, or disable output for tasks that do not need it.
```

**Worktree launch fails**
```typescript
// Ensure the git working tree is clean and task cwd overrides match the shared cwd.
```

**Child fails before starting**
```typescript
// Inspect `subagent({ action: "status", id: "..." })`, artifact metadata/output logs, and run doctor. Extension loader errors usually appear in child output logs.
```
