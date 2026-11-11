# Local agent communication

`intercom` is always available with the package. There is no `load_intercom`,
child-only supervisor tool, peer overlay, topic registry, or separate extension
to install. Ordinary and delegated sessions use the same messaging tool.

Background failures appear as native notifications when a UI is active and on
stderr in print or JSON mode, including during headless shutdown. In UI sessions,
failures during shutdown or after the UI context is unavailable are recorded in
`intercom/background-errors.log` under `PI_CODING_AGENT_DIR` (normally `~/.pi/agent`).
If that directory is not writable, the fallback cannot record them. Repeated
identical failures are reported once until the affected operation recovers.

## Discovery and groups

```js
intercom({ action: "list" });
intercom({ action: "list", children: true });
intercom({ action: "list", scope: "project" });
intercom({ action: "list", to: "reviewer" });
intercom({ action: "list", device: "all" });
intercom({ action: "status" });
```

Default discovery includes every eligible connected session under the same OS
user, across cwd, Git worktrees, projects, HOME settings, and Pi agent directories.
`scope:"project"` is an optional convenience filter, not an authority boundary.
The list does not enumerate all OS processes or disconnected native sessions.
With `device`, `list` prints the main sessions of the owner's
[other devices](#main-sessions-on-other-devices) instead.

`list` and `status` print the current session and then two blocks:

1. **Main sessions.** One line per main with its name, target, cwd, model and
   state. Sessions of one repository and its worktrees sit together: the block is
   sorted by project, then by name.
2. **Child sessions of the caller's group.** One line in total: how many there
   are, counted by state, and the call that prints their rows.
   `list` with `children: true` prints one line per child instead.

Every child is a valid target by name or ID whether or not its row is printed.
With `to`, `list` keeps the sessions whose name or ID contains that text, ignoring
case. It filters both blocks, says how many sessions each block holds in total,
and prints every matching child row. The delivery guidance is printed once after
the blocks.

| Caller                | First block      | Second block                   |
| --------------------- | ---------------- | ------------------------------ |
| Main with children    | Every other main | Its own children, as a count   |
| Main without children | Every other main | Absent                         |
| Child                 | Its main         | The other children, as a count |

A bridge identity is a main: it is a row in the first block of every main. It
reads the mains through the bridge's own `list` route, not through this tool.

A main session and its children form a collaboration group. Main↔child and
sibling↔sibling communication works in both directions. Across groups, only
main↔main communication is allowed. A child cannot discover, message, or read
another group's main or children—even using a known exact ID. Only mains spawn;
there is one child level. These are broker-enforced coordination rules, not an OS
security sandbox against arbitrary code running as the same user.

Registration pins `rootSessionId` and optional `parentSessionId`. Both are native
Pi session IDs, not cwd or display names. A main uses its own ID as root, without
a parent. A child uses its main's ID for both. An offline parent does not erase
sibling membership. Presence updates cannot change the registered group. Legacy
or remote peers without lineage are standalone mains.

Pi launches a child with both `PI_INTERCOM_ROOT_SESSION_ID` and
`PI_INTERCOM_PARENT_SESSION_ID` set to its main's exact native ID. With neither
set, the session is a main. Any other combination (one missing, empty, padded
with whitespace, or different values) stops the package from loading, so that
session gets neither delegation nor Intercom. Values are never trimmed into a
different identity.

### Identity and targeting

Use a target returned by `list`. Native peer IDs are `pi-` plus the first 32
hexadecimal SHA-256 characters of the native session ID. Reconnecting normally
reuses that identity. A simultaneous live collision gets a different ID; it never
merges with or evicts the first connection.

Names are mutable and nonunique. Exact IDs take precedence; otherwise names and
sufficiently long ID prefixes must resolve unambiguously. Displayed targets grow
when needed to distinguish collisions. A project-filtered peer can still be
addressed by its known target; a topology-forbidden peer cannot. A hidden peer
does not leak through duplicate-name ambiguity or disconnect notifications.

### Conditional native context targeting

Ordinary `intercom` names and asks are unchanged. Integrations can negotiate
guarded-delivery version 1 with the native broker client. Discovery then exposes
`rootSessionId`, `incarnation`, `guardedDelivery:1` and the optional opaque
`applicationGuard`. The lifecycle mints the incarnation on native startup, reload
or session replacement, not on transport reconnect. Peer IDs still belong to
the broker. Two current mains for one root make guarded sends ambiguous.

A guarded send requires an exact peer ID, a caller-recorded original message ID,
`expectsReply:false`, and
`guard:{rootSessionId,peerId,incarnation,applicationGuard}`. The broker checks
the complete binding before routing; the native recipient checks again before
initial admission, before its first checkpoint or immediate placement. Children
are not guarded command targets. Missing capability, stale context, changed
consent or an ambiguous root fails closed for new admission, never selecting a
similarly named main. A broker acceptance still does not prove
recipient admission. Lost responses remain uncertain; no automatic replay is added.
The supported non-model package client below uses these same native protocols.

Withdrawing the guard stops new admission; it does not cancel already-admitted
input. The original native session remains the recovery owner after a checkpoint,
including across reload or process recovery. A fork or new root cannot adopt its
pending inputs. Native queueing or placement is not proof of model consumption.

An original-main companion uses the existing process-local `pi.events` bus:

- Emit `pi-intercom:context-query` with `{version:1,respond(snapshot)}` for late
  attachment. Unknown versions return `{error:"unsupported_version"}`.
- Observe `pi-intercom:context-state` for subsequent lifecycle, connection and
  application-guard changes. Snapshots contain `version:1`, exact root, optional
  parent, actual `peerId`, `incarnation`, `connected`, negotiated
  `guardedDelivery:1|null`, and optional `applicationGuard`. Unavailable identities
  are null. Query after subscribing; state events are not replayed.
- Emit `pi-intercom:application-guard` with
  `{version:1,target:{rootSessionId,peerId,incarnation},revision,respond(result)}`.
  The companion owns this opaque nonempty string revision; null withdraws it.
  A stale target returns `{error:"context_changed"}`. It is cleared on context
  replacement and retained on transport reconnect. This handshake is not consent
  itself, does not persist a policy, and grants no human-origin authority.

Callbacks are process-local, synchronous observations. They are not socket frames
or a generic registry. Old owners have no handshake; treat them as unsupported.
Old brokers do not acknowledge guarded delivery, so updated clients refuse before
sending. Old ordinary clients and recipients continue using ordinary messages;
they are not advertised as conditional targets.

Guarded nonblocking messages may include
`replyHint:{tool,commandId,commandFingerprint?}`. Tool names are validated identifiers and command IDs
are immutable UUIDs supplied by the sender. An optional lowercase SHA-256
`commandFingerprint` is opaque to Intercom; its caller owns the fingerprint
contract. The native message renders a generic
publication hint separately from an ordinary ask. No product-specific tool is
hard-coded, no pending ask is created, and a hint does not prove a reply exists.

## Main sessions on other devices

```js
intercom({ action: "list", device: "all" });
intercom({ action: "list", device: "laptop" });
intercom({ action: "list", device: "laptop", to: "review" });
intercom({ action: "send", to: "api-fix@laptop", message: "The schema change is merged." });
intercom({ action: "ask", to: "api-fix@laptop", message: "Which port does the API use?" });
```

A main session can list the main sessions on the owner's other devices, send a
message to one of them, and ask one of them a question. For a list, `device` is
one configured device name, or `all` for every configured device. The answer has
one block per device and no session of this device:

```text
**Main sessions on laptop (2):**
• api-fix@laptop (pi-7e8f9@laptop) — Native session cwd: /work/api (model-b) [idle, state:idle, accepts_asks:true, pending_asks:0, last_intercom_activity:none, last_seen:2h ago]
• web-build@laptop (pi-0a1b2@laptop) — Native session cwd: /work/web (model-a) [tool:bash, state:busy, accepts_asks:false, pending_asks:0, last_intercom_activity:none, last_seen:5s ago]

**Main sessions on desk (0):** no Pi session is connected there.

**phone:** unreachable (connect to host phone port 22: Operation timed out)

**old-box:** not listed: its pi-subagents has no cross-device command; update pi-subagents there

**Other devices:** send and ask reach a main there by its target above, which ends in @device. last reads only the sessions of this device.
```

- A row has the fields of a local main row. Its name and its ID end in `@device`.
  Ages are measured on the clock of the listed device.
- Only Pi main sessions are listed. The children and the bridge identities of
  the other device are left out.
- `to` keeps the sessions whose name or ID contains that text, as in a local
  list. A text copied from a row can keep its `@device` ending: it matches that
  row on that device. `scope` and `children` cannot be combined with `device`.
- The name and the ID of a row are targets for `send` and `ask`. `last` reads
  only the sessions of this device.
- Only a main session can use `device` or a `name@device` target. A child gets a
  refusal, and its main handles anything that involves another device. Like the
  group rules, this is a coordination rule, not a sandbox against code that runs
  as the same user.
- Without `device` and without a `name@device` target, the tool contacts no
  other device.

| Block text                                                 | Meaning                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `(0): no Pi session is connected there`                    | The device answered. No broker runs there, or no Pi main is connected to it.                         |
| `unreachable (…)`                                          | `ssh` could not connect or log in. The text in parentheses is the last line that `ssh` printed.      |
| `not listed: its pi-subagents has no cross-device command` | The device answered. This package is not installed there, or its version is older than this command. |
| `not listed: node is not on the PATH of its SSH commands`  | The device answered. Its shell did not find `node` for a command that `ssh` runs without a terminal. |
| `not listed: …`                                            | Any other failure, with the last line of its error text.                                             |

### Send to and ask a main on another device

`to` is a name or an ID from a device list, with its `@device` ending. The text
after the last `@` selects the device when it is a configured device name, in
any letter case. Such a target always goes to that device, also when a session
of this device has the same full name. The part before the `@` is resolved on
the other device like a local target: by name, by ID, or by an ID prefix of at
least 8 characters. `@` with the name of this device is refused with the target
to use instead.

```text
Message sent to api-fix@laptop (defaults to steer; wakes idle recipients and steers active recipients after the current tool call)
```

```text
**Reply from api-fix@laptop:**
Port 8443.
```

The recipient reads the sender as `<session name>@<sender's device>`, with the
sender's working directory. That name is the target for a message back:

```text
**📨 From web-build@desk** (Native session cwd: /work/web)

The schema change is merged.
```

- **Send.** The answer is the receipt of the other device's broker: accepted,
  delivered or queued, as for a local send. `delivery`, `queueMode`, `threadId`
  and attachments work as for a local target. A later queued message
  with `queueMode:"replace"` replaces the sender's earlier one of the same
  thread.
- **Ask.** The tool waits for the reply up to the asker's `askTimeoutMs`. The
  recipient answers with `reply`, or with `send` and `replyTo`, as for a local
  ask.
- **A busy recipient.** A default ask of a main that is not accepting asks is
  refused and not sent. Use `send`, or ask with `delivery:"steer"` to reach the
  recipient at its next tool boundary and wait.
- **When nobody waits any more.** After the timeout, a cancelled tool call or a
  lost connection, the question is retired on the recipient's device: `pending`
  and the list stop counting it. A late `reply` then fails because no ask is
  pending; `send` to the sender's name reaches it.
- **What stays on the device.** Human origin, application guards and reply
  hints never cross a device.

A failure says whether the message left this device:

| Text                                                                                            | Meaning                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Not sent to <device>: unreachable (…)`                                                         | `ssh` could not connect or log in. Nothing was sent.                                                                              |
| `Not sent to <device>: its pi-subagents has no cross-device command; update pi-subagents there` | The device answered. This package is not installed there, or it has no cross-device command. Nothing was sent.                    |
| `Not sent to <device>: its pi-subagents is older than this command; update pi-subagents there`  | The device answered. Its package lists sessions and does not send or ask yet. Nothing was sent.                                   |
| `Not sent to <device>: no Pi session is connected there`                                        | The device answered. No broker runs there. Nothing was sent.                                                                      |
| `Message to "<target>" was not delivered: …`, `Ask to "<target>" was not sent: …`               | The other device has no connected session for that target, or refused it. Nothing was sent.                                       |
| `Target "<target>" is too short` or `matches multiple sessions`                                 | The other device found more than one session. The text lists the targets to use, each with its `@device` ending.                  |
| `No reply from "<target>" within …`                                                             | The question arrived. No reply came before the timeout.                                                                           |
| `The ask reached <device>, and the connection was lost before a reply came (…)`                 | The question arrived. The reply, if any, is lost.                                                                                 |
| `Delivery unknown: <device> gave no answer after the request was handed over (…)`               | The connection was lost after the device had the request. The message may have arrived. Check the recipient before sending again. |
| `Cancelled`                                                                                     | The tool call was cancelled. The details say whether the message was accepted, was not sent, or is unknown.                       |

"Not sent" is certain: the device answers with one line before the request is
written to it, and a device that did not answer received nothing.

### Device names

Device names come from `intercom/config.json` under `PI_CODING_AGENT_DIR`
(normally `~/.pi/agent/intercom/config.json`):

```json
{
  "device": "desk",
  "otherDevices": ["laptop", "phone"]
}
```

| Key            | Value                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device`       | The name of this device: the SSH alias that the other devices use for it.                                                                                  |
| `otherDevices` | The other devices: the SSH aliases that this device uses for them. An entry equal to `device` is skipped, so the same list can be written on every device. |

A name consists of letters, digits, `.`, `_` and `-`, and starts with a letter
or a digit. No device is reachable until both keys are set: a list with `device`
then answers that no devices are configured and names this file and both keys,
and a `name@device` target is read as the name of a local session. Set both keys
on every device: a recipient needs the sender's device in its own `otherDevices`
to send a message back. A session reads the file when it starts or reloads.

### How a device is reached

For each list of a device, each send and each ask, the tool runs one `ssh`
command. With `all`, the list commands run at the same time. An ask keeps its
command open until the reply, the timeout or the cancellation.

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 <device> '<command>'
```

`<command>` is the same for every device and every request. It prints an empty
line, runs the first installed copy of this package's
`dist/pi-intercom/remote-cli.js` under the home directory, and exits with status
44 when there is none. The tool writes the request only after that first line:

```sh
echo; test -f ~/.pi/agent/git/github.com/fitchmultz/pi-subagents/dist/pi-intercom/remote-cli.js && exec node ~/.pi/agent/git/github.com/fitchmultz/pi-subagents/dist/pi-intercom/remote-cli.js; test -f ~/.pi/agent/npm/node_modules/@fitchmultz/pi-subagents/dist/pi-intercom/remote-cli.js && exec node ~/.pi/agent/npm/node_modules/@fitchmultz/pi-subagents/dist/pi-intercom/remote-cli.js; exit 44
```

The other device needs:

- SSH login with a key and without a prompt, under the alias in `otherDevices`.
- This package, installed by Pi from Git or from npm in the default agent
  directory `~/.pi/agent`.
- `node` on the `PATH` of a command that `ssh` runs without a terminal.

`remote-cli.js` reads one JSON request from stdin and prints its JSON reply as
the last line on stdout. The replies are wrapped here for reading:

```json
{ "version": 1, "command": "list", "origin": "desk" }
```

```json
{
  "version": 1,
  "now": 1794350610543,
  "sessions": [
    {
      "id": "pi-…",
      "name": "api-fix",
      "cwd": "/work/api",
      "model": "model-b",
      "status": "idle",
      "acceptsAsks": true,
      "pendingAsks": 0,
      "lastSeen": 1794343410543
    }
  ]
}
```

A send or an ask carries the sending main as its own broker lists it, the
target without its `@device` ending, and the message:

```json
{
  "version": 1,
  "command": "ask",
  "origin": "desk",
  "device": "laptop",
  "from": { "id": "pi-…", "name": "web-build", "cwd": "/work/web" },
  "to": "api-fix",
  "message": { "text": "Which port does the API use?", "messageId": "…" },
  "timeoutMs": 120000
}
```

```json
{
  "version": 1,
  "receipt": { "id": "…", "accepted": true, "delivered": true },
  "reply": {
    "id": "…",
    "timestamp": 1794350611000,
    "replyTo": "…",
    "content": { "text": "Port 8443." }
  }
}
```

A failure is `{ "version": 1, "error": "…" }` with exit status 1. A package
that lacks a command answers `Unsupported command "<command>".`

The command joins the running broker of its device as a main, does its work,
and leaves. It never starts a broker: without a running broker it answers a list
with an empty list and a message with "no Pi session is connected there". No
listener, service or port is added on any device.

- For a list, the main is named `intercom-list@<origin>`.
- For a message, the main is named `<sender name>@<origin>`, with the sender's
  working directory and the model name `remote-cli`. Its ID is `remote-` and a
  hash of the origin and the sender's ID, so every command of one sender is the
  same peer to the recipient. Device lists leave these mains out.
- A waiting ask first prints the receipt of its question as a line of its own,
  then an empty line every second. The receipt tells the asker that the question
  arrived, also when the connection is lost later. The empty lines tell the
  command that its caller is gone: the next write fails, the command leaves, and
  the recipient retires the question.

For each listed main, these fields leave its device, inside the SSH connection:
ID, name, cwd, model, project ID, status, `acceptsAsks`, `pendingAsks`,
`lastSeen` and `lastIntercomActivity`.

## Send, ask, and reply

```js
intercom({ action: "send", to: "reviewer", message: "Check refresh-token rotation." });
intercom({ action: "ask", to: "reviewer", delivery: "steer", message: "Which invariant fails?" });
intercom({ action: "pending" });
intercom({
  action: "reply",
  replyTo: "<message-id>",
  message: "The rotated token remains usable.",
});
```

- Default **steer**, for both sends and incoming asks, wakes an idle recipient or
  reaches busy work at a tool boundary. Print-mode recipients use the same rule;
  they do not replace an ordinary ask with a canned busy reply.
- Explicit **queue** defers delivery. Optional `queueMode:"replace"` with a nonempty
  `threadId` coalesces still-staged updates for that thread; messages already handed
  to Pi's native queue cannot be keyed-replaced.
- Explicit **passive** is a non-waking breadcrumb, not a request for model work.
  The recipient reads it at its next turn. Use it for receipts and FYI that need
  no action.

Do not send acknowledgements, thanks or receipts that need no action, and do not
reply to a message that needs none. A default send to an idle recipient costs it
a full model request. Send only what the recipient must act on or must know to
avoid a mistake. A sender that needs proof a message was read uses `ask`.

An ordinary send is non-blocking. Its response means broker acceptance, not
recipient journal persistence, model consumption, reply, or task completion. A
lost transport response can be uncertain; do not blindly replay side effects.

When a local transport send loses its acknowledgement, the tool error retains the
original `messageId` and reports `deliveryUnknown:true`. It omits `accepted` and
`delivered` because neither outcome is confirmed. Local validation failures before
dispatch report `deliveryUnknown:false`, `accepted:false`, and `delivered:false`.
Neither path retries the message automatically. If an ask is acknowledged but its
reply wait later times out, is cancelled, or loses its peer, the error preserves
the broker's `accepted` and `delivered` fields and reports `deliveryUnknown:false`.
A rejected concurrent ask that never reaches the transport is not sent.

`ask` waits for a correlated reply and has a bounded timeout. Prefer `send` unless
the sender genuinely must remain alive waiting for a decision. If an ordinary ask
finds a peer advertising `acceptsAsks:false`, the sender still reports `peer_busy`
without waiting; recipient steering does not claim that a reply has arrived.
Explicit steer/queue asks retain their bounded correlated wait. `reply` uses the
active or sole pending ask when unambiguous; otherwise specify `replyTo` and the
intended sender. Inspect `pending` for the exact correlation rather than guessing
from text.

Messages accepted for a parked child remain queued until it returns. If its
owner reports a failed wake, a waiting ask returns the failure and says that the
accepted question may still arrive later. Check the child before resending to
avoid a duplicate question. A later active message requests another wake. Inspect
the child's run for its last recorded wake failure. With older brokers or
clients that cannot report wake outcomes, a waiting ask keeps its usual timeout.

This ordinary request/reply mechanism does not recreate the retired durable
supervisor approval/revival workflow. An expired wait is not an answered question
or a completed delegated run.

## Read the last response without waking

```js
intercom({ action: "last", to: "reviewer" });
// Follow the returned entryId/nextOffset for large responses:
intercom({ action: "last", to: "<exact-peer-id>", entryId: "<entry-id>", offset: 16384 });
```

The native owner reads the last completed assistant response on its active
branch. This is original assistant text, not a run-status summary. No direct
message, prompt, or model turn is created. Empty history is reported explicitly.

Pages are bounded to 16,384 UTF-16 code units. Keep `entryId` for stable paging and
use the returned next offset; do not calculate byte offsets. A newer response
does not silently replace the requested entry halfway through retrieval. Missing
or no-longer-readable entries fail explicitly. Tool output and thought blocks are
not substituted for completed assistant text.

The broker assigns request tokens and verifies the answering peer and page
identity. Reads settle on response, disconnect, or timeout. Old peers/brokers
without the capability report unsupported reads instead of receiving unknown
message frames. Broker correlation does not grant access to another group.

## Native-owned receipts and publication provenance

Receipt reads are non-waking and distinct from `last`. The native client
negotiates `receiptReads:1` with the broker, which also checks the recipient's
capability before forwarding `{rootSessionId,messageId}`. Old brokers or owners
are unavailable, not a reason to send an unknown frame or parse their journals.
Receipt and last reads share the broker's private token, answering-peer,
timeout and disconnect owner. A receipt response must match the exact requested
native root and message ID. No model-facing receipt action is added.

A companion in the original main emits `pi-intercom:provenance-query` on
`pi.events` with `{version:1,rootSessionId,messageId,respond(result)}`. The loaded
Intercom owner reads its own readonly native SessionManager and responds
synchronously with `{receipt}` or `{error}`. Unknown versions, an inactive owner
or a different root return `publication_unavailable`. An absent checkpoint
returns `receipt_not_found`, which proves neither no effect nor task success.
Missing handlers are unsupported; there is no packaged parser fallback.

The version-1 receipt contains the exact root and message ID, original sender
peer/root/incarnation where recorded, requested delivery, received timestamp,
checkpoint entry ID, selected guard and publication-hint fields, and
`textSha256`. That hash is lowercase SHA-256 of the exact raw sender text encoded
as UTF-8, before banners, hints, or newline/Unicode normalization. It is computed
independently of the caller's opaque `commandFingerprint`. No input text,
attachments, thoughts, cwd, model settings or native journal path is returned.

Facts remain separate:

- `checkpointEntryId` observes the original owner's appended delivery record.
  It is not a per-entry fsync or power-loss durability receipt.
- `queued` records an observed extension staging checkpoint.
- `nativeHandoff` records the native-handoff checkpoint, written before calling
  Pi's send API. It does not prove that call succeeded or the provider accepted
  input.
- `placementEntryId` identifies the actual native custom-message entry, or null
  when no placement was observed. Placement is not semantic model consumption.
- `discarded` records an explicit discard checkpoint when one exists.

These are historical positive observations, not a claim that an input is still
queued. Provider-input admission and model consumption remain unknown. Finals,
settlement and ordinary replies are not fabricated command publications.

Receipt reads inspect the exact original session's journal, including its other
branches. They retain the immutable original sender after ordinary departure,
reload, compaction and cold reopen. They never depend on a live pending ask.
Copied history in a fork/new root cannot attest the original root's checkpoint.
This is separate from `last`, which remains active-branch-only and keeps pinned
entry paging semantics.

## Supported non-model client

Install this package as a normal Node.js dependency and import its supported
subpath. Pi and TypeBox peers are optional; a companion needs neither them nor
provider credentials. Importing this entry does not load the extension, CLI,
TUI, session manager, journal parser or model SDK.

```js
import { connectIntercom } from "@fitchmultz/pi-subagents/intercom-client";

const client = await connectIntercom({
  spawn: false,
  session: {
    name: "my-companion",
    cwd: process.cwd(),
    model: "non-model-client", // A registration label, not a model to initialize.
    rootSessionId: savedSenderRoot,
    incarnation: savedSenderIncarnation,
  },
});
try {
  const peers = await client.listSessions();
  // Join selected consent to one exact advertised main; do not select by name.
  const target = peers.find((peer) => peer.id === savedTarget.peerId);
  if (!target) throw new Error("Original target unavailable");
  const result = await client.send(savedTarget.peerId, {
    messageId: savedMessageId,
    text: savedText,
    expectsReply: false,
    delivery: "steer",
    guard: savedTarget, // rootSessionId, peerId, incarnation, applicationGuard
    replyHint: {
      tool: "my_publication_tool",
      commandId: savedCommandId,
      commandFingerprint: savedCommandFingerprint,
    },
  });
  // result describes broker acceptance, not native or provider admission.
  const receipt = await client.receipt(savedTarget.peerId, {
    rootSessionId: savedTarget.rootSessionId,
    messageId: savedMessageId,
  });
  const page = await client.last(savedTarget.peerId, { limit: 16384 });
  // Keep page.entryId and page.nextOffset for subsequent pages.
} finally {
  await client.disconnect();
}
```

The example's saved values belong to the caller's immutable command record, not
to this client. Persist that record and the actual `client.sessionId` before the
attempt. `requestedId` is optional and can collide; only the returned current
identity attests this connection. The client creates no ledger, consent, second
session or model loop. Registration does not grant human-origin authority.

`connectIntercom` requires literal `spawn:false` and never starts a missing or
old broker. It uses the normal same-user namespace or the caller's explicit
`PI_INTERCOM_RUNTIME_DIR`; it does not change global Pi configuration or infer a
fallback namespace. Connection failure rejects. `sendTimeoutMs` and
`listTimeoutMs` bound native requests; optional `onError(error)` observes socket
errors. Outstanding operations reject on loss. `isConnected()` and `sessionId`
report current transport state, not recipient activity or successful work.
`disconnect()` closes this socket and joins its cleanup; reconnect explicitly
with a new `connectIntercom` call. There are no reconnect or resend timers.

Public sends require an original message ID, explicit delivery, `expectsReply:false`
and the complete exact guard. Concurrent sends with one pending ID reject rather
than replacing its acknowledgement waiter. Invalid inputs, old capability
negotiation, stale consent/context and ambiguous roots never downgrade to an
ordinary send. The generic hint and opaque fingerprint are optional native
metadata, not an ordinary ask or a guaranteed reply.

After any unconfirmed send, keep the original ID and target. Reconcile only with
`receipt`; never generate another UUID, reroute or assume that missing means
unsent. A later explicit new operation is the caller's decision, not an automatic
retry. Receipt facts retain the original sender after departure. Unsupported old
brokers or owners fail closed; `publication_unavailable` and `receipt_not_found`
do not establish no effects. `last` is separately non-waking and pinned by entry
ID; it is not a correlated command reply. Ordinary local Intercom name resolution,
asks and topology are unchanged.

Only `./intercom-client` and `./package.json` are public package subpaths.
Private transport, broker, extension and parser paths are not supported imports.
The Pi resource manifest still loads its compiled extension independently.

## Persistence and lifecycle

Inbound state is checkpointed in the recipient's native session journal. Native
publication/consumption receipts govern replay; broker writes alone do not.
Queued, admitted, consumed, and replied are distinct states. Reload, compaction,
branch changes, shutdown, and fresh-process recovery must not fabricate receipts
or adopt another native session's pending messages.

An already-admitted message ID cannot publish a second copy or revive an answered
ask. The same applies to replies received by a blocking ask and to deliberately
replaced/discarded queued messages, including native journal restoration. A new ID
is a new input even if its text is identical. This recipient-side deduplication is
not an end-to-end exactly-once guarantee for arbitrary tool side effects.

Idle recovery preserves admission order within the non-passive backlog and wakes
once on its last item; passive breadcrumbs are appended before that waking work.
The first unresolved eligible ask remains the implicit reply target, independently
of which message triggers the turn. Reply attribution refers to the unresolved
ask by ID. Placing delayed input does not revive an already replied, expired, or
retired reply obligation. A failed turn can retire only an ask whose input Pi has
consumed; queued input remains answerable after abort recovery.
A busy recipient's steer is handed to Pi's native
queue and consumed at its next tool boundary; no extension probe asks another
tool to give up the turn.

Shutdown joins admitted inbound work before detaching its native owner. Stale
runtime generations must not checkpoint or deliver into a replacement session.
Context state is inactive, live with its session and incarnation, or invalidated
while transport cleanup retains the session ID. Clearing cleanup drops that ID;
transport connection and native tool activity remain separate from context validity.
The native tests own these contracts; neither a timer nor a source-string test is
publication evidence.

## Shared broker and migration

Default files on macOS/Linux:

- `/tmp/pi-intercom-<uid>/broker.sock`
- `/tmp/pi-intercom-<uid>/broker.pid`
- `/tmp/pi-intercom-<uid>/broker.spawn.lock`

Native Android/Termux uses `$PREFIX/tmp/pi-intercom-<uid>` instead of `/tmp`.
This is shared across the app's sessions, not derived from a session's HOME,
agent directory, or TMPDIR. Android without a Termux PREFIX uses Node's native
temporary directory. The separate read-only child observation endpoints use
the same runtime-root policy.

The runtime directory is owned by the OS user, nonsymlink, and mode 0700; the
socket is mode 0600. The broker starts on first use and exits after five seconds
without connected sessions, unless a parked child still holds admitted input; that
input waits for its main to return and wake the child. Concurrent startup uses the shared spawn lock.

`PI_INTERCOM_RUNTIME_DIR` explicitly selects an isolated deployment. It must be
an absolute private directory with a socket path within 100 UTF-8 bytes. Invalid
configuration fails without falling back to another namespace. Set it consistently
for every process intended to share that isolated broker. Tests must always use
an owned isolated directory, never the user's ordinary shared socket.

Old releases used agent-directory-specific brokers. Updated sessions join the
new shared namespace; old sessions stay on their old brokers until they load the
updated extension. Startup warns when it detects an old broker for the current
agent directory. It does not kill, modify, take over, or silently route back to
that broker. During migration, old and new peers may therefore be invisible to
each other. Finish accepted work before upgrading; do not force broker shutdown
to make discovery appear complete. During an authorized cutover, inventory and
reload every participating Pi session on that Mac before resuming bridge traffic,
then verify the expected exact peers from both mains and the helper. The warning
only detects old brokers for the current agent directory; it cannot certify that
all old sessions elsewhere have migrated.

The predictable macOS/Linux `/tmp` namespace is independent of caller HOME/TMPDIR, which is
needed for same-user discovery across differently configured sessions. A foreign
user who pre-creates that path can deny availability, but cannot be adopted as the
broker owner: startup refuses foreign or symlink directories. It must not delete
or take over the path to recover. On shared hosts, an operator can pre-provision
a short private directory under an owned non-writable parent and consistently set
`PI_INTERCOM_RUNTIME_DIR` for every participating Pi session and helper. This is
an explicit deployment choice, not an automatic fallback to a split namespace.

An unresponsive or missing socket is not permission to kill a possibly live
owner. PID checks are conservative, including permission-denied cases. Linux
records include native boot/namespace/start identity to reject proven PID reuse;
ambiguous legacy numeric PIDs remain blocking. A process is never killed merely
to recover broker startup.

Startup distinguishes absent, live and uncertain ownership. An unreadable or
invalid PID record is uncertain, not permission to launch another broker.
A startup claim stays owned while its process is live, regardless of age.
Only a proven exited or replaced owner permits reclaiming it. Linux claims carry
the same native process identity as broker PID records. Legacy or incomparable
identities remain blocking; a timestamp alone cannot prove PID reuse.
Each starter keeps the claim's
file descriptor open and releases only the same device/inode, leaving a
replacement claim untouched.

Remote authenticated mail is separate: see [bridge setup](intercom-bridge.md).
