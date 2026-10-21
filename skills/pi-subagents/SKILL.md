---
name: pi-subagents
description: "Delegate one complete assignment to a native Pi child; inspect, continue, wait for, or stop saved child runs. Use for Pi delegation, not profile administration or non-Pi agents."
---

# Pi delegation

Use the eager `delegate` and `agent_runs` tools. There is one agent type and no
profile discovery, loader, role body, chain DSL, or nested delegation.

## Assignment

```js
delegate({
  prompt: "Complete assignment with constraints and expected output",
  name: "short-name",
});
```

Supply the complete prompt: relevant original requirements, settled decisions or
readable references, scope and files, authority and non-goals, verification venue,
expected result, and stop boundary. Do not rely on a hidden profile to add them.

Fresh context is default; `context:"fork"` preserves the native conversation,
including prior tool results. A forked child still cannot delegate. Optional
`cwd` and `model` are explicit launch overrides; do not change global auth/model
settings to implement an override.
`model:"provider/model:thinking"` uses Pi's native suffix resolver when the host
exports it; a literal model ID wins before suffix parsing. Without that host API,
use a literal ID with inherited thinking or upgrade Pi. Never retry another model
silently.

Runs are asynchronous unless `async:false`. Continue useful independent work;
when child evidence gates the next step, end the turn and await completion rather
than polling. A launch receipt is not completion. Review actual outputs and
validation evidence before accepting the result.

## Controls

- `agent_runs({action:"list"})` discovers this native main's saved runs.
- `inspect` reads a run by ID; follow returned offsets for complete output.
- `continue` takes a complete follow-up `prompt` and keeps the saved child chat.
  Active work receives guidance; completed work gets an immutable successor.
- `wait` observes existing work; cancelling that wait does not stop the producer.
- `stop` requests termination. Inspect actual process evidence; request acceptance
  does not prove actor or command exit.

Use IDs returned by the tools. Runs belong to their native main session, not a
cwd, project, name, or forked copy of its transcript. Resume the same main for
ownership. Do not delete ambiguous launch state to force another attempt.

## Coordination and delivery

All pairs inside a main/children group can use `intercom` list/send/last. Across
groups, mains alone can communicate. Children cannot see or address foreign
groups, and cannot spawn children. `last` reads original completed assistant text
without waking a peer; it is not a completion notification or replacement for
run inspection.

Keep writers isolated and integration parent-owned. Prefer bounded independent
review with a fresh complete brief. Retain native SDK/journal/process boundary
proof; a child-reported pass is evidence to inspect, not automatic sign-off.

Normal child completion returns through the run, not a redundant intercom
message. Use direct `send` for guidance, corrections, or blockers that affect live
work. Ordinary `ask` is bounded request/reply, not durable supervisor revival.
