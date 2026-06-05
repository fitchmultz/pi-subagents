# Upstream issue: whole-invocation fork promotion ignores per-agent `defaultContext: fresh`

## Status

Fixed in this fork by `src/shared/agent-context-policy.ts`; still present in the locally inspected upstream refs as of 2026-06-05.

## Summary

Upstream `pi-subagents` promotes the **entire** invocation to `fork` when `context` is omitted and **any** requested agent has `defaultContext: "fork"`.

That causes read-only agents configured with `defaultContext: fresh` (for example `scout`, `reviewer`) to inherit the full parent transcript when batched with `worker` or `oracle` in parallel or chain mode.

This fork intentionally resolves context per child when top-level `context` is omitted.

## Reproduction against upstream

1. Configure `scout` with `defaultContext: fresh`.
2. Configure `worker` with `defaultContext: fork`.
3. Run a parallel subagent call without explicit `context`:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find relevant files" },
    { "agent": "worker", "task": "Implement fix" }
  ]
}
```

4. Upstream runs both tasks with forked/inherited parent context.

Root cause in upstream: `applyAgentDefaultContext()` in `src/runs/foreground/subagent-executor.ts` promotes the whole invocation.

## Expected behavior

When caller omits top-level `context`:

- Each agent/task/step should use **its own** `defaultContext`.
- Explicit `context: "fresh"` or `context: "fork"` should override all agents in that call.
- Parallel scout + worker should fork only the worker task, not the scout.

## Fork behavior

The fork implements the policy in `src/shared/agent-context-policy.ts`:

- resolve context per agent/default through `resolveAgentContext()`;
- wrap fork prompts only for fork-resolved children;
- allocate fork session files only for child indexes whose resolved context is `fork`;
- preserve invocation-level metadata that a mixed run used fork context for badges/status.

## Migration impact

Users relying on upstream's implicit whole-invocation fork when mixing fork-default and fresh-default agents must pass explicit `context: "fork"` for that behavior.
