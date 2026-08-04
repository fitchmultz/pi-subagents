---
name: pi-intercom
description: "Coordinate local Pi sessions with pi-intercom: list peers, send updates, ask blocking questions, reply to inbound asks, use contact_supervisor, or handle pi-subagents escalations. Do not use for generic chat, remote/cross-machine messaging, unrelated repos, routine subagent completion, or work this session can finish."
---

# Pi Intercom

## Goal

Coordinate named Pi sessions on the same machine with the least context loss and the fewest interruptions.

## Source of truth

- A bounded ambient hint may report that same-project peers are connected. It contains counts only and never sends a message; use `intercom({ action: "list" })` before choosing a target.
- `intercom({ action: "list" })` is the source of truth for targetable sessions. It shows only intercom-connected sessions, not every Pi process, with live ask capability, busy/idle/unknown state, recent intercom activity, and delivery guidance. The current-session row is not targetable; choose a peer from Other sessions.
- Tool call shapes and options live in the live `intercom` / `contact_supervisor` schemas, `docs/intercom.md`, and `src/pi-intercom/index.ts`. Read those when a parameter detail is needed; do not invent fields.
- Pi CLI flags for local peer sessions are `--name`, `--extension`, and `--skill`.

## Use when

- Delegating a bounded task to another already-running Pi session.
- Sending findings, code snippets, file context, progress, or blockers to a specific session.
- Asking a peer for a decision or clarification you need before continuing.
- Replying to an inbound intercom ask.
- Handling a formatted `pi-subagents` supervisor escalation.

## Do not use when

- The current session can finish the work directly.
- The target is remote or on another machine; pi-intercom is local IPC only.
- The task is unrelated to the recipient's repo or role.
- A normal `subagent` run is enough and no visible peer conversation is needed.
- The message would expose secrets, tokens, passwords, private data, or unrelated user context without explicit approval.
- Routine subagent completion or final handoff; return that through `pi-subagents`, not intercom/`contact_supervisor`.

## Default workflow

1. Decide whether a peer is actually needed. If not, keep working locally.
2. Discover targets with `intercom({ action: "list" })` before sending.
3. Pick the displayed name or target ID exactly. If names collide, use the target shown by `list`. Never message the current session.
4. Choose the lightest action:

| Action | Use for | Effect |
| --- | --- | --- |
| `send` | Guidance, answers, corrections, blockers, context, or other non-blocking coordination | Defaults to steer: it wakes idle recipients or reaches busy recipients at the next tool boundary, then returns after broker acceptance. Use explicit queue only when delay is intentional and passive only for human-visible breadcrumbs. |
| `ask` | A required answer when this process must remain alive waiting for it | Use `delivery:"steer"`; waits up to `askTimeoutMs` (default 2 minutes). Default asks to peers reporting `accepts_asks:false` return `delivered:true`, `replied:false`, `reason:"peer_idle"`, while explicit steer asks keep waiting; not passive. |
| `reply` | Answering an inbound ask | Uses the active ask, or the single pending ask |
| `pending` | Multiple or delayed inbound asks | Lists unresolved asks so you can disambiguate |
| `status` | Troubleshooting connection state | Shows connection, active session count, and the same live recipient capability/guidance rows as `list` |

5. Write compact messages with objective, scope, relevant files, stop boundary, and expected reply. Attachments only when the recipient needs the extra context.
6. For live agent-to-agent coordination, use non-blocking `send`; omitted delivery steers by default. Then end the turn or continue independent work. Use explicit queue only when delay is intentional; optional `delivery:"queue", queueMode:"replace", threadId:"<non-empty>"` keeps only the latest undelivered update for that thread.
7. Treat inbound steers as coordination within the active task: incorporate relevant context and continue. Replace the task only when the message explicitly says so. Reply to an active ask with `reply`; otherwise respond with default-steered `send`.
8. Use blocking `ask` only when this process must stay alive and cannot safely continue without the answer. After any tool result, handle the reply or error; do not assume delivery after failure.

## Supervisor escalations from pi-subagents

When present, child sessions get a child-only `contact_supervisor` tool; normal sessions use `intercom`. Do not assume `contact_supervisor` exists unless the tool is listed.

Child-side reasons only: blocking `need_decision` or `interview_request` when the ephemeral child cannot safely continue and must remain alive for the reply, or an intentionally deferred `progress_update` for a concise material update.

Supervisor-side: answer formatted child escalations with `intercom` `reply`.

| Type | Meaning | Supervisor response |
| --- | --- | --- |
| `need_decision` | Child cannot safely continue without one decision or approval | Reply promptly with a clear decision |
| `interview_request` | Child cannot safely continue without multiple structured answers | Reply with JSON using the requested ids |
| `progress_update` | Child intentionally deferred a concise material update | Read it; reply only if redirecting |

Interview replies use plain JSON or a fenced JSON block. `info` questions are context only and need no response entries:

```json
{
  "responses": [
    { "id": "api", "value": "Stable API" },
    { "id": "constraints", "value": "Keep the public error shape unchanged." }
  ]
}
```

If a subagent status line advertises an intercom target, trust it only when that target appears in `intercom({ action: "list" })`. If absent, use normal subagent controls (`status`, `resume`, `nudge`, result artifacts); the child may be Claude Code-backed or already exited and have no child-side `contact_supervisor`. From a parent session, prefer `subagent({ action: "nudge", id, message })` for non-blocking live child coordination; it supplements the active child task unless it explicitly replaces it. Use direct `intercom({ action: "ask", to, delivery: "steer", message })` only when the parent process must remain alive and cannot safely continue without a listed child reply.

## Optional visible peer sessions

Read `references/peer-sessions.md` before starting a new visible peer session. Spawn one only when all are true:

- No connected peer from `intercom({ action: "list" })` already fits.
- The user benefits from watching or resuming a long-lived peer conversation.
- The peer works in the same repo or an intentional reference repo.
- You can run a smoke ask before delegating real work.

## Failure handling

- No other sessions: do not invent a target. Start a peer only if the optional visible-peer rule holds.
- `Session not found`: run `list`, choose the exact displayed target, then retry if still useful.
- `Already waiting for a reply`: wait for the current ask, use `send` for non-blocking context, or continue local work.
- Multiple pending asks: run `pending`, then use its copy-ready `reply` call or disambiguate with the displayed `to` or `replyTo` value.
- Ask timeout: summarize the blocked decision and continue only with safe local work.
- Busy non-interactive recipient auto-reply: it cannot respond while running; use subagent controls or wait.

## Completion evidence

A good intercom-assisted turn ends with:

- Target came from `list` or from the active inbound ask.
- Action matched intent: default-steered `send` for live coordination, `ask` only for a required blocking reply, `reply` for an inbound ask, explicit queue only for intentional delay, and passive only when deliberately not waking the model.
- Delivery result or failure was handled.
- Any spawned peer was smoke-tested and either still needed or cleaned up.
