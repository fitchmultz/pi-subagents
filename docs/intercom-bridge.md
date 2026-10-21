# Authenticated remote Intercom messaging

The optional standalone Node HTTPS helper lets a trusted remote Grok agent
exchange messages with reachable Pi peers. It preserves durable inbox transfer,
certificate-derived identity and unattended Grok wake/recovery. It does not start
or resume Pi sessions, inspect saved transcripts, control native processes,
manage groups, broadcast, or keep synchronous ask waiters.

Starting Pi never starts this helper. The broker remains a same-user Unix socket;
remote callers cannot send raw frames. Peer IDs and ambiguity handling belong to
the existing Intercom resolver. Discovery/target visibility follows the upstream
lineage owner; the helper does not infer agent roles or groups from names/cwd.
Remote Box identities register as standalone mains: they can reach local mains,
not delegated children. Children cannot address the Box, even by exact ID; their
main coordinates any remote exchange.

## Transport and authority

- The helper binds only `127.0.0.1`, TLS 1.2+ with required client certificates.
  The client verifies the server CA and loopback SAN. Never disable verification.
- A valid client certificate also needs its SHA-256 pin in private config. The
  pin fixes its `remote-<fingerprint>` peer ID, display name and home cwd. A
  request cannot supply another sender identity. Expiry/revocation deny new
  requests, restored presence and wake delivery. Invalid reload denies everyone.
- Tailscale Serve may forward raw TCP to loopback; it must not terminate TLS.
  Restrict the port to trusted remote hosts. Do not use Funnel or a wildcard bind.
  An approved Mac-initiated SSH reverse loopback forward is also possible.
- Authenticated message text remains untrusted input. This is coordination, not
  an OS sandbox: the receiving agent's ordinary tools/budget still apply.
- The Mac must be awake, logged in and online. Mail waits durably while Grok is
  away; the helper cannot reach Pi while its Mac is asleep/offline.

stdout contains JSONL metadata only: identities, message/peer IDs and outcomes,
not message text or secrets. Keep logs private. Connections are capped at 128,
concurrent operations per identity at eight, request bodies at 64 KiB and ordinary
HTTP deadlines at 15 seconds. Browser-origin/fetch-metadata requests are denied.

## Configuration

Use Node >=24.21.0 and the packaged `dist/pi-intercom/bridge.js`. Provision an
immutable reviewed release, keep the prior compiled release for rollback and
point a separately supervised service at it. Installation/restart is an explicit
operator gate, not an effect of editing this repository.

The credential script requires OpenSSL with `req -addext` support:

```sh
umask 077
node scripts/intercom-bridge-credentials.mjs init /absolute/private/bridge grok-bot --cwd /home/you --port 9443 --days 3650
```

`init` refuses an existing directory. The script prints paths, not private values;
CA/server private keys remain on the Mac. Client lifetime defaults to seven days;
explicit unattended credentials may last up to 3650 days. `issue`, `revoke` and
`renew-server` preserve the existing storage/locking boundaries; see `--help`.
Only approved operators provision credentials through a secure channel.

Config and secret files must be owned private regular files (0600), all paths
absolute. Public CA/certificate files need not be secret. `stateDir` must exist,
be owned 0700 and be symlink-free. Example:

```json
{
  "port": 9443,
  "ca": "/absolute/private/bridge/ca.crt",
  "cert": "/absolute/private/bridge/server.crt",
  "key": "/absolute/private/bridge/server.key",
  "stateDir": "/absolute/private/bridge/state",
  "clients": [
    {
      "fingerprint256": "SHA256_FROM_ISSUE",
      "name": "grok-bot",
      "cwd": "/home/you",
      "wake": { "envFile": "/absolute/private/bridge/grok-wake.env" }
    }
  ]
}
```

The optional owned 0600 `wake.envFile` contains `GROK_WAKE_WEBHOOK_URL` (HTTPS,
no URL credentials/fragment) and `GROK_WAKE_WEBHOOK_KEY`. Wake requires durable
`stateDir`. Omit wake for a polling-only client. Omit `stateDir` only for legacy
volatile messaging: 256 messages / 4 MiB, no cold presence or wake recovery.
The retired client `launch` key is accepted but ignored, with one metadata warning
per configuration load. Its paths and policies are not read or executed and it
grants no capability; remove it when convenient. Other unknown fields still fail
closed, with a bounded, control-free field name in the diagnostic. No credentials
or configuration files are automatically rewritten.

Run with the same per-user broker environment as local Pi:

```sh
PI_CODING_AGENT_DIR=/home/you/.pi/agent node dist/pi-intercom/bridge.js --config /absolute/private/bridge/config.json
```

On macOS preserve the user's native `TMPDIR` for old-namespace detection (see
`getconf DARWIN_USER_TEMP_DIR`); it does not select the new shared broker.
Observe `listening` before requests. A per-user LaunchAgent can supervise this
command with private logs, RunAtLoad and KeepAlive. SIGTERM/SIGINT drain helper
requests and disconnect its own peers; they never stop the shared broker.
SIGHUP reloads client/wake policy. Listener/TLS/stateDir changes require restart.
KeepAlive restarts a terminated helper; boot out the service to stay stopped.

Durable presence safely acquires the existing broker after reboot/crash. It
never restarts/replaces a live or uncertain unhealthy owner. Legacy volatile
messaging does not start a broker. The existing native PID/spawn lock owner
retains that safety boundary.

## Protocol and maintained client

Every operation requires mTLS and the current pin. Responses include
`{ok,requestId,...}`; non-2xx faults include `error:{code,message,...}`. TLS may
close before HTTP when authentication fails. There are no automatic mutation
retries. A lost response is **UNKNOWN**, not proof that a message was unsent.

| Route               | Input                                                     | Result                                                     |
| ------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `POST /v1/register` | `{}`                                                      | credential-derived `sessionId`, `name`                     |
| `GET /v1/list`      | none                                                      | `sessionId`, peers with exact IDs/unambiguous targets      |
| `POST /v1/send`     | `{to,message,messageId?,passive?,replyTo?,expectsReply?}` | real broker send receipt                                   |
| `GET /v1/inbox`     | `after`, `limit=1..256`, `waitMs=0..10000`                | complete envelopes, `nextCursor`, `hasMore`, loss metadata |
| `POST /v1/ack`      | `{ids}` (at most 256)                                     | `acked`; durable intake ownership transferred              |

`to` uses the existing exact-ID/name resolver; ambiguity never selects a peer.
Explicit message IDs survive byte-for-byte. `passive:true` is mailbox-only and
never wakes. Acceptance means transport/broker admission, not native journal
persistence, model start, reply completion or task completion. A bare `ok:true`
is not an acceptance receipt.

The maintained client is `scripts/intercom-remote.mjs`. Copy it unchanged with
only the CA, client certificate and private key to a private remote directory.
Set `INTERCOM_BRIDGE_URL` to the local forwarder HTTPS origin and
`INTERCOM_BRIDGE_CA/CERT/KEY` to the appropriate files. It accepts only
`register`, `list`, `send`, `inbox` and `ack`; run `--help` for arguments.

```sh
node intercom-remote.mjs list
node intercom-remote.mjs send --to EXACT_ID --id REQUEST_ID --expects-reply --message 'Status?'
node intercom-remote.mjs send --to ORIGINAL_SENDER_ID --reply-to REQUEST_ID --message 'Answer'
```

Replies are ordinary correlated sends. The consumer must fsync the **complete
sender/message envelope**, including `replyTo`/`expectsReply`, before ACK. ACK
now tombstones all payloads, including requests expecting a reply. Pending work
and reply duties belong to the durable consumer mailbox after transfer; there
is no server `retained` ask or synchronous HTTP waiter. Failed/offline replies
must leave that local duty pending. Exact-ID tombstones prevent replay
resurrection. Cursor pages are bounded by count and 4 MiB; long-waits observe
post-commit changes and never consume messages. Durable reads/ACKs remain
available while the broker is unavailable.

## Wake and cold recovery

Authenticated presence is durably recorded and restored only for current,
unexpired pins. Each private SQLite mailbox uses the proven FULL-sync owner.
Mailbox commits schedule fallback after a short durable postcommit ACK grace
(target two seconds), independent of consumer polling. Passive mail never wakes.
ACK retires notification intent; webhook HTTP acceptance alone does not.

Wake reservations persist before POST. One shared Mac ledger covers all
fingerprints/URLs: at most 20 attempts per sliding hour with persisted backoff,
uncertain-attempt recovery and clock-rollback protection. A live owner never
ages out an open attempt. Cold recovery conservatively retains a full hour for
an uncertain stopped owner. Invalid/unreadable state fails closed, never resets
usage. Separate state directories are independent budgets, not a way to multiply
an installation's allowance. Preserve quota/history through upgrades.

The companion Box worker independently ingests each profile, fsyncs before ACK,
deduplicates and recovers from cursor zero. Its wake owner separately tracks
accepted versus consumed/failed mail. This is bounded at-least-once notification,
not exactly-once model execution. Multiple Macs and slow ACKs can duplicate wakes.

## Paired upgrade gate

Qualify this source and `grok-pi-bridge` together. Its bundled client must be
byte-identical to this maintained client; use real broker/mTLS tests as well as
mailbox/filesystem checks. Never pin a nonexistent future SHA. Select the actual
reviewed immutable upstream commit only after publication; an older pin/client
is not evidence for the new reply/ACK protocol.

The cutover is a coordinated boundary, not a rolling mixed-protocol upgrade:

1. Obtain deployment GO; inventory the participating Pi sessions/agent directories,
   helper services and both Box workers, including external wake/health routines.
   Stop admission of new remote work and pause every worker starter. Checkpoint or
   finish old synchronous asks and remotely owned work before changing versions.
2. Preserve native journals, SQLite/presence/quota state and Box STORE ledgers, plus
   the prior compiled helper, extension and client/worker pair. On each Box, run
   the companion's offline `mail reconcile` dry run, review the exact obligations,
   explicitly apply safe unambiguous scoped receipts, and verify the pending set.
   Ambiguous IDs remain pending. Follow its RUNBOOK for old open wake reservations;
   they are not completion evidence and must not be reset to obtain fresh budget.
3. Load the approved extension in **every participating Pi session on each Mac**
   before restarting helper traffic. Old and new namespaces cannot see or forward
   to each other. The startup warning covers the current agent directory only;
   neither `list` nor the warning inventories every OS process. Verify the expected
   exact peer IDs from the new main sessions and the helper before proceeding.
4. Swap the reviewed helper and Box client/worker pair while starters remain
   paused. Update saved bot prompts/routines: remote `spawn`, `resume`, `sessions`,
   `transcript`, groups and broadcast are retired; replace `ask`/`reply` with
   correlated `send`. An existing client `launch` config is ignored, not a startup
   blocker. Verify per-Box pending duties and authenticated discovery/delivery,
   then resume starters. Do not leave an old worker reading new-client receipts.

The companion must pin the **final immutable upstream revision selected for
rollout**, with green paired CI; a merge/squash that changes the selected revision
requires refreshing that pin and qualification before deployment. A doc-only
change does not itself change the protocol, but it is still a different reviewed
source identity. Neither PR is permission to merge or activate the pair.

For rollback, pause starters/traffic again and enumerate transferred Box reply
duties from its durable mailbox. Complete and verify those replies before restoring
old server-owned reply tooling; receipt reconciliation is not proof that a reply
was sent. If duties cannot be resolved, retain the new pair rather than pretending
the old helper can recover already-ACKed payloads. The Box's newer-code guard
intentionally rejects ordinary downgrade copies. Reinstating prior behavior needs
a separately reviewed, version-aware paired recovery (for example, a qualified
forward-versioned recovery release), not falsifying version stamps or using normal
bootstrap to force old code. Preserve mail/quota/history throughout. Never reset
history, fabricate consumption or resurrect mail. No source check installs/restarts
a runtime or proves provider execution.
