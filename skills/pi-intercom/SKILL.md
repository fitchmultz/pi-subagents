---
name: pi-intercom
description: "Discover eligible local Pi sessions, send guidance, ask/reply, or read a peer's last completed response without waking it. Use for same-machine Pi coordination, not generic chat or unrelated remote messaging."
---

# Pi Intercom

The `intercom` tool is eager. There is no loader, separate child supervisor tool,
workflow UI, or topic registry.

1. Use `intercom({action:"list"})` before choosing a peer. Default discovery spans
   projects and agent directories under the same OS user; optional
   `scope:"project"` filters to this repository and its worktrees.
2. Pick the exact displayed target. Names are not unique; resolve ambiguity rather
   than guessing. The current session is not a peer target.
3. Choose the lightest operation:
   - `send`: non-blocking guidance/corrections/blockers; default delivery steers.
   - `last`: original last completed assistant text, without waking the peer.
   - `ask`: bounded correlated wait only when the sender must stay alive waiting.
   - `reply`: answer the active/sole pending ask, or specify `replyTo` when ambiguous.
   - `pending`: unresolved inbound asks and their correlation.
   - `status`: connection, peer health and inbound queue state.
4. Handle the actual outcome. Broker acceptance is not recipient persistence,
   model consumption, a reply, completion, or process exit. Do not replay an
   uncertain side effect merely because its response was lost.

## Topology

A main and its children form one group. Every pair inside it can communicate.
Mains can also communicate with other mains. Children cannot discover, send to,
or read a foreign group's agents—even with an exact ID. Only mains delegate;
there is one level. Cwd and agentDir do not define groups. These are coordination
rules, not a sandbox against other code running as the same OS user.

## Delivery and paging

Default `send` steers at the next tool boundary or wakes an idle peer. Explicit
`delivery:"queue"` intentionally defers. Explicit `delivery:"passive"` never wakes
and is for breadcrumbs, not actionable work. Ordinary live agent guidance should
not be passive.

`last` returns a stable entry ID and offsets. Follow its exact next-page call to
retrieve all text; offsets are UTF-16 code units, not bytes. A read never sends a
model prompt. It does not substitute a fabricated status summary for the answer.

Keep messages compact and self-contained: objective, scope, files, authority,
stop boundary, and expected reply. Never attach secrets or unrelated private
context. Use ordinary run completion for delegated handoff, not duplicate sends.

## Recovery

If a target disappears, list again. A timeout is not a reply. Multiple pending
asks require explicit correlation. Ordinary asks do not recreate the retired
persistent supervisor question/approval workflow.

Old agent-directory brokers may coexist during migration; updated sessions use
the same-user broker. Do not kill another broker or change runtime configuration
to force discovery. Only intercom-connected eligible sessions appear, not all
open Pi processes. See `docs/intercom.md` for broker and persistence contracts.
