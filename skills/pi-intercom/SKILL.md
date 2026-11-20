---
name: pi-intercom
description: "Discover eligible local Pi sessions, send guidance, ask/reply, or read a peer's last completed response without waking it. Use for same-machine Pi coordination, not generic chat or unrelated remote messaging."
---

# Pi Intercom

The `intercom` tool is eager. There is no loader, separate child supervisor tool,
workflow UI, or topic registry.

1. Use `intercom({action:"list"})` before choosing a peer. It prints the main
   sessions first, then the child sessions of your group as one count line. A
   child is a valid target by name or ID without its row; `children:true` prints
   the rows. Rows include `git: <repo> (<branch>)` when the peer is inside a Git
   repository (branch name or detached short SHA), `working_on:<note>` when the
   peer set a claim, `worker_started:<age>` (the current worker process age,
   refreshed on `pi restart`), and `last_turn_error:<error>` when the peer's most
   recent assistant turn failed. Default discovery spans projects and agent
   directories under the
   same OS user; optional `scope:"project"` filters to this repository and its
   worktrees, and optional `to` keeps the sessions whose name or ID contains it,
   child rows included.
2. Pick the exact displayed target. Names are not unique; resolve ambiguity rather
   than guessing. The current session is not a peer target.
3. Choose the lightest operation. The lightest is no message: do not send
   acknowledgements, thanks or receipts. Send only what the peer must act on or
   must know to avoid a mistake. When a message you receive needs no action, do
   not reply and do not restate it.
   - `send`: non-blocking guidance/corrections/blockers; wakes an idle peer
     (a full model request for it) and steers a busy peer at its next tool boundary.
   - `last`: original last completed assistant text, without waking the peer;
     unpinned reads also report `Latest turn failed (<entryId>): <error>` when a
     newer assistant turn on the active branch failed.
   - `ask`: steers/wakes the peer and waits for a correlated reply; use only
     when the sender must stay alive waiting for the answer.
   - `reply`: answer the active/sole pending ask, or specify `replyTo` when ambiguous.
     When a main answers a scope or contract question from one of its owned child runs,
     pass optional `contract` to validate and persist the contract amendment atomically
     before delivering the reply (rejected for non-reply actions, non-owned senders,
     or invalid contracts without sending the reply).
   - `pending`: unresolved inbound asks and their correlation.
   - `status`: connection, peer health and inbound queue state.
   - `claim`: set or clear (`message:""`) a short 1-line `workingOn` note on
     your presence record in `list` without waking any peer.
4. Handle the actual outcome. Broker acceptance is not recipient persistence,
   model consumption, a reply, completion, or process exit. Do not replay an
   uncertain side effect merely because its response was lost.

## Topology

A main and its children form one group. Every pair inside it can communicate.
Mains can also communicate with other mains. Children cannot discover, send to,
or read a foreign group's agents—even with an exact ID. Only mains delegate;
there is one level. Cwd and agentDir do not define groups. These are coordination
rules, not a sandbox against other code running as the same OS user.

## Other devices

A main can list the main sessions on the owner's other devices:
`intercom({action:"list", device:"all"})`, or one device name. The answer has one
block per device, with rows written `name@device`, and no session of this device.
A device can also be unreachable, have no Pi session, or lack the command; its
block says which.

The name and the ID of a row are targets: `send` and `ask` with
`to:"name@device"` reach that main. Its reply to an ask comes back as the tool
result. A message from another device shows its sender as `name@device`; use
that as `to` for a message back, and `reply` for an ask. A failure says whether
the message was not sent, or whether its delivery is unknown; check the
recipient before sending an unknown one again. `last` reads only the sessions of
this device.

A child cannot use `device` or a `name@device` target; its main does that. If no
devices are configured, a `device` list names the file and the keys to set.

## Delivery and paging

Every `send` and `ask` steers a busy peer at its next tool boundary or wakes an
idle peer. There is no queued or passive delivery mode on the tool—if an agent
sends a message, the recipient sees it promptly.

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
open Pi processes. See [local messaging](../../docs/intercom.md) for broker and
persistence contracts.
