# Local agent communication

`intercom` is always available with the package. There is no `load_intercom`,
child-only supervisor tool, peer overlay, topic registry, or separate extension
to install. Ordinary and delegated sessions use the same messaging tool.

## Discovery and groups

```js
intercom({ action: "list" });
intercom({ action: "list", scope: "project" });
intercom({ action: "status" });
```

Default discovery includes every eligible connected session under the same OS
user, across cwd, Git worktrees, projects, HOME settings, and Pi agent directories.
`scope:"project"` is an optional convenience filter, not an authority boundary.
The list does not enumerate all OS processes or disconnected native sessions.

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

An ordinary send is non-blocking. Its response means broker acceptance, not
recipient journal persistence, model consumption, reply, or task completion. A
lost transport response can be uncertain; do not blindly replay side effects.

`ask` waits for a correlated reply and has a bounded timeout. Prefer `send` unless
the sender genuinely must remain alive waiting for a decision. If an ordinary ask
finds a peer advertising `acceptsAsks:false`, the sender still reports `peer_busy`
without waiting; recipient steering does not claim that a reply has arrived.
Explicit steer/queue asks retain their bounded correlated wait. `reply` uses the active or sole pending
ask when unambiguous; otherwise specify `replyTo` and the intended sender. Inspect
`pending` for the exact correlation rather than guessing from text.

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
The first eligible ask remains the implicit reply target, independently of which
message triggers the turn. Bursts of correlated asks share one bounded handoff
probe rather than retaining one event listener per message.

Shutdown joins admitted inbound work before detaching its native owner. Stale
runtime generations must not checkpoint or deliver into a replacement session.
The native tests own these contracts; neither a timer nor a source-string test is
publication evidence.

## Shared broker and migration

Default files on macOS/Linux:

- `/tmp/pi-intercom-<uid>/broker.sock`
- `/tmp/pi-intercom-<uid>/broker.pid`
- `/tmp/pi-intercom-<uid>/broker.spawn.lock`

The runtime directory is owned by the OS user, nonsymlink, and mode 0700; the
socket is mode 0600. The broker starts on first use and exits after five seconds
without connected sessions. Concurrent startup uses the shared spawn lock.

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

The predictable `/tmp` namespace is independent of caller HOME/TMPDIR, which is
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

Remote authenticated mail is separate: see [bridge setup](intercom-bridge.md).
