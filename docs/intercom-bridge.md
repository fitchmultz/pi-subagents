# Secure remote Intercom bridge

The bridge lets one authenticated remote agent, such as a Grok bot, work with Pi on your Mac unattended. It can message and ask any live Pi session, keep incoming messages and asks in a durable mailbox, wake the agent when mail sits unread, browse live and saved sessions, spawn and resume sessions, read recent transcripts, cancel or stop work, and broadcast to named groups.

The bridge is a standalone Node HTTPS helper, `dist/pi-intercom/bridge.js`. Starting Pi never starts it. Pi-intercom's broker stays a same-machine Unix socket, and remote callers can't send raw broker frames.

## Design

**Transport.** The helper listens only on `127.0.0.1`. Tailscale Serve exposes that port to your tailnet as a raw TCP forwarder, and the remote host reaches it through a forwarder on its own loopback. TLS runs end to end between the remote client and the helper; Tailscale carries encrypted bytes and never terminates TLS. Don't use Funnel, `--https` or `--tls-terminated-tcp` for this port. A Mac-initiated [SSH reverse forward](#ssh-alternative) also works.

**Authentication.** TLS 1.2+ mutual authentication. A client presents a certificate issued by the bridge's private CA, and its SHA-256 fingerprint must be in the private allowlist. The client verifies the server against the same CA and its loopback SAN (`localhost`, `127.0.0.1`), so remote clients always use a loopback URL. Never use `curl -k` or disable verification.

**Authority.** Each allowlisted certificate fixes one identity: its peer name, its Intercom ID (`remote-<fingerprint>`) and its home `cwd`. Request payloads can't change identity, and display names grant nothing. An authorized identity can use every bridge capability: list peers in any project, send text that agents treat as instructions, read transcripts, manage groups, spawn and resume sessions in any locally approved directory with any model, and cancel or stop work. Spawned sessions use your local tools, credentials and model budget. mTLS authenticates the caller; it doesn't sandbox the agents or make messages trustworthy. Issue certificates only to agents you trust with that authority. There is no broker-admin, raw RPC, shell or caller-supplied file-path endpoint.

**Threat model.** The bridge denies unauthenticated callers on the tailnet or the Mac, revoked or expired certificates, identity spoofing, forged replies and control results, browser-origin requests and unbounded waits. It trusts the Mac user account, the OS, the broker, the private CA and the authorized remote host. Compromised endpoints and denial of service beyond the fixed connection and request limits are out of scope.

**Broker.** The helper reuses Intercom's client, socket discovery and framing, so run it with Pi's `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) and macOS per-user `TMPDIR`. It never restarts or replaces a live broker. Legacy messaging without `stateDir` never starts a broker. Persistent presence and resume use Pi's safe acquisition, including before any Pi session starts after reboot: reuse a healthy broker, start a detached broker only when none is running, and refuse a second broker while an unhealthy broker process may still own accepted work. Acquisition uses the normal PID-file/spawn-lock bookkeeping.

**Availability.** The Mac must be awake, online and logged in, because the helper runs as a per-user LaunchAgent. Mail for the remote agent waits in its Mac mailbox while the agent is away. Nothing reaches Pi while the Mac is asleep, powered off or offline.

**Audit.** stdout is JSONL metadata: identity, fingerprint, route, peer and message IDs, and outcomes, including wake and launch results. Message bodies, wake keys and private keys are never logged. Keep logs in a 0700 directory with 0600 files.

## Mac setup

You need Node 24.21.0+, OpenSSL with `req -addext` (Homebrew OpenSSL works), Tailscale on both machines, and Pi with this package's Intercom extension. Examples use the identity `fitch-os` on port 9443. Replace `/Users/you` and other placeholders.

### 1. Install a release

Install each helper version into a new directory and never edit it afterward. The service runs whatever `current` points to.

```bash
RELEASES="$HOME/.pi/intercom-bridge-releases"
NEW="$RELEASES/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$NEW"
npm install --prefix "$NEW" --omit=dev @fitchmultz/pi-subagents
PKG="$NEW/node_modules/@fitchmultz/pi-subagents"
node "$PKG/dist/pi-intercom/bridge.js" --help
ln -sfn "$NEW" "$RELEASES/current"
```

### 2. Create credentials

```bash
umask 077
BRIDGE="$HOME/.pi/intercom-bridge"
node "$PKG/scripts/intercom-bridge-credentials.mjs" init "$BRIDGE" fitch-os --cwd "$HOME" --port 9443 --days 3650
```

`init` refuses an existing directory. It creates a ten-year CA, a one-year loopback server certificate, a client certificate whose CN is the identity name, and a private 0600 `config.json`. `--port` (default 9443) sets the helper port. `--days` (1–3650, default 7) sets the client certificate lifetime for `init` and `issue`. Authorization uses only the fingerprint. The last JSON line lists file paths and never secrets. `ca.key` and `server.key` stay on the Mac.

### 3. Configure

```bash
mkdir -m 700 "$BRIDGE/state" "$BRIDGE/sessions" "$BRIDGE/wake" "$BRIDGE/logs"
# Two lines in a 0600 file. Keep it out of Git, logs and shell history.
(umask 077; printf 'GROK_WAKE_WEBHOOK_URL=%s\nGROK_WAKE_WEBHOOK_KEY=%s\n' "$WAKE_URL" "$WAKE_KEY" > "$BRIDGE/wake/fitch-os.env")
```

Add `stateDir`, `wake` and `launch` to the generated `config.json`. Keep the file 0600.

```json
{
  "port": 9443,
  "ca": "/Users/you/.pi/intercom-bridge/ca.crt",
  "cert": "/Users/you/.pi/intercom-bridge/server.crt",
  "key": "/Users/you/.pi/intercom-bridge/server.key",
  "stateDir": "/Users/you/.pi/intercom-bridge/state",
  "clients": [
    {
      "fingerprint256": "FINGERPRINT_FROM_INIT",
      "name": "fitch-os",
      "cwd": "/Users/you",
      "wake": { "envFile": "/Users/you/.pi/intercom-bridge/wake/fitch-os.env" },
      "launch": {
        "packageRoot": "/absolute/path/to/node_modules/@earendil-works/pi-coding-agent",
        "sessionDir": "/Users/you/.pi/intercom-bridge/sessions",
        "workspaceRoots": ["/"],
        "resumeDirs": ["/Users/you/.pi/agent/sessions"],
        "context": "You were started by the remote fitch-os agent through the Intercom bridge. Reply through Intercom.",
        "extensions": [
          "/absolute/path/to/pi-subagents/dist/pi-intercom/index.js",
          "/absolute/path/to/pi-subagents/dist/extension/index.js"
        ],
        "discoverResources": true,
        "trustProject": true,
        "maxSessions": 16
      }
    }
  ]
}
```

This example gives the agent full authority over every Mac path. The defaults stay restrictive for other identities.

| Field                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stateDir`                        | Owned 0700 directory, required for unattended use. Holds one 0600 SQLite mailbox per certificate fingerprint, presence proofs and groups. Symlinks, wrong owner or mode, and hard links are rejected. Change it only with a helper restart. Without it, the helper falls back to a legacy volatile inbox (256 messages, 4 MiB) with no wake or presence restore, and keeps groups in `$PI_CODING_AGENT_DIR/intercom/bridge-state`. |
| `cwd`                             | The identity's presence and project association, the legacy `start` directory and the default spawn directory. It doesn't limit access.                                                                                                                                                                                                                                                                                            |
| `wake.envFile`                    | Absolute path to an owned 0600 file defining `GROK_WAKE_WEBHOOK_URL` (HTTPS, without URL credentials or fragment) and `GROK_WAKE_WEBHOOK_KEY`. Requires `stateDir`. Reread on SIGHUP.                                                                                                                                                                                                                                              |
| `launch`                          | Enables saved-session browsing, spawn and resume. Omit it for a messaging-only identity.                                                                                                                                                                                                                                                                                                                                           |
| `packageRoot`                     | The installed Pi package for children. The helper runs that package's `bin.pi` with its own physical Node. Use the intended installed Pi, not a development SDK with the same version.                                                                                                                                                                                                                                             |
| `sessionDir`                      | Owned 0700 directory for new journals, written 0600.                                                                                                                                                                                                                                                                                                                                                                               |
| `workspaceRoots`                  | Up to 32 directories. Spawn and resume directories must be inside one. `["/"]` approves every path; the default empty list rejects spawn and resume.                                                                                                                                                                                                                                                                               |
| `resumeDirs`                      | Up to 32 owned directories searched, with `sessionDir`, for saved sessions. Every journal path component must be owned and symlink-free.                                                                                                                                                                                                                                                                                           |
| `provider`, `model`               | Optional default model; set both or neither. Omit them to use Pi's normal model selection.                                                                                                                                                                                                                                                                                                                                         |
| `extensions`                      | 1–32 absolute extension paths, including Intercom. With `discoverResources: true`, use the same physical Intercom path that native settings load, so a session never runs two Intercom copies.                                                                                                                                                                                                                                     |
| `discoverResources`               | Default `false`. `true` keeps Pi's normal discovery of extensions, skills, prompts and context files.                                                                                                                                                                                                                                                                                                                              |
| `trustProject`                    | Default `false`. Chooses native `--approve` or `--no-approve` for the selected directory.                                                                                                                                                                                                                                                                                                                                          |
| `offline`                         | Default `false`. `true` disables automatic catalog and network activity; requested inference still runs.                                                                                                                                                                                                                                                                                                                           |
| `maxSessions`, `startupTimeoutMs` | Owned-session cap per identity, 1–16 (default 4; 32 per helper), and readiness deadline, 1–60000 ms (default 15000).                                                                                                                                                                                                                                                                                                               |

Children inherit the helper's environment, minus enclosing `PI_SUBAGENT_*` metadata, so set `PATH` in the service. A launch succeeds only when the exact saved session ID, name and file run idle in RPC mode and the session's own Intercom peer is published. That proves startup, not working provider credentials. A Pi dialog that needs a human is cancelled, and the session is stopped with `interaction_required`.

### 4. Run as a LaunchAgent

Save as `~/Library/LaunchAgents/com.example.pi-intercom-bridge.fitch-os.plist`. Use your real Node path, and the output of `getconf DARWIN_USER_TEMP_DIR` for `TMPDIR`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.pi-intercom-bridge.fitch-os</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/Users/you/.pi/intercom-bridge-releases/current/node_modules/@fitchmultz/pi-subagents/dist/pi-intercom/bridge.js</string>
    <string>--config</string>
    <string>/Users/you/.pi/intercom-bridge/config.json</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PI_CODING_AGENT_DIR</key><string>/Users/you/.pi/agent</string>
    <key>TMPDIR</key><string>/var/folders/XX/YYYY/T/</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/Users/you/.pi/intercom-bridge/logs/audit.jsonl</string>
  <key>StandardErrorPath</key><string>/Users/you/.pi/intercom-bridge/logs/stderr.log</string>
</dict>
</plist>
```

```bash
LABEL=com.example.pi-intercom-bridge.fitch-os
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
plutil -lint "$PLIST" && launchctl bootstrap "gui/$(id -u)" "$PLIST"
lsof -nP -iTCP:9443 -sTCP:LISTEN   # expect only 127.0.0.1:9443
```

Wait for the `listening` audit record before making requests. Day-to-day control:

```bash
launchctl kill SIGHUP "gui/$(id -u)/$LABEL"    # reload allowlist, launch and wake policy
launchctl kill SIGTERM "gui/$(id -u)/$LABEL"   # graceful restart; KeepAlive starts the current release
launchctl bootout "gui/$(id -u)" "$PLIST"      # stop and stay stopped
```

SIGHUP can't change the port, TLS files or `stateDir`; restart for those. With `KeepAlive`, killing the process only restarts it, so use `bootout` to stop access. SIGTERM stops owned sessions before exit, which is why `ExitTimeOut` allows 30 seconds.

### 5. Publish on the tailnet

```bash
tailscale serve --bg --tcp=9443 tcp://localhost:9443
tailscale serve status
```

Restrict that port in your tailnet policy to the remote host. To withdraw it, run the same `serve` command with `off` appended.

### 6. Provision the remote host

Copy only the client certificate and key printed by `init`, `ca.crt`, and `scripts/intercom-remote.mjs`, over an existing secure channel, into a 0700 directory with 0600 files. Then run a supervised loopback forwarder from `127.0.0.1:9443` to the Mac's tailnet name on port 9443. With kernel-mode Tailscale:

```bash
socat TCP-LISTEN:9443,bind=127.0.0.1,reuseaddr,fork TCP:mac-name.example-tailnet.ts.net:9443
```

Without root, run `tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055` and relay the same loopback listener through that SOCKS5 proxy.

```bash
export INTERCOM_BRIDGE_URL='https://127.0.0.1:9443'
export INTERCOM_BRIDGE_CA="$HOME/.config/pi-intercom/ca.crt"
export INTERCOM_BRIDGE_CERT="$HOME/.config/pi-intercom/client.crt"
export INTERCOM_BRIDGE_KEY="$HOME/.config/pi-intercom/client.key"
REMOTE="$HOME/.config/pi-intercom/intercom-remote.mjs"
node "$REMOTE" register && node "$REMOTE" list
```

The first authenticated connection establishes persistent presence (see [Mailbox, presence and wake](#mailbox-presence-and-wake)).

### More instances

Run one helper per remote agent instance. Each instance gets its own client name and key, port, `stateDir`, wake webhook, LaunchAgent label, Tailscale Serve port and remote host.

Helpers on the same Mac must share one CA; `init` always creates a new one. Pi sessions on the Mac check every native control (see [Stop and cancel](#stop-and-cancel)) against a single policy file: `PI_INTERCOM_BRIDGE_CONFIG`, else `$PI_CODING_AGENT_DIR/intercom/bridge.json`, else `~/.pi/intercom-bridge/config.json`. That file must name the common CA and list the current pin of every instance, so update it whenever you issue, rotate or revoke any instance's certificate. A different Mac has its own CA and policy file.

### SSH alternative

A Mac-initiated SSH reverse forward can replace steps 5 and 6. Use an approved Linux account, keep host-key checking and don't forward your agent:

```bash
ssh -NT -a -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:9443:127.0.0.1:9443 user@linux-host
```

On Linux, `ss -ltn '( sport = :9443 )'` must show only `127.0.0.1:9443`. `GatewayPorts=yes` forces a wildcard bind; require `no` or `clientspecified`. A dedicated tunnel key can be limited with `restrict,port-forwarding,permitlisten="127.0.0.1:9443",command="/bin/false"`. Never reuse the bridge client key as an SSH key.

## Remote API

Every route requires mTLS and the allowlist. Bodies are JSON up to 64 KiB. Unknown routes, fields, query keys and browser-origin requests are rejected. Success is `{ "ok": true, ... }`; failure is `{ "ok": false, "error": { "code", "message", ... } }` with a non-2xx status. A failed certificate check can end the TLS handshake before any HTTP response. Nothing retries a mutation automatically. A lost response means the outcome is unknown, so inspect the inbox, sessions or peer before retrying.

`intercom-remote.mjs` wraps the routes with the verbs `register`, `list`, `send`, `ask`, `inbox`, `reply`, `ack`, `start`, `spawn`, `resume`, `sessions`, `stop`, `cancel`, `capabilities`, `transcript`, `groups`, `group-upsert`, `broadcast` and `group-send` (broadcast that requires `--group`). Run it with `--help` for options. It prints JSON and exits 0 on success, 1 on an API, TLS or transport failure and 2 on invalid arguments. The examples below call routes directly:

```bash
api() { # api METHOD PATH [JSON]
  curl --fail-with-body -sS --max-time 135 \
    --cacert "$INTERCOM_BRIDGE_CA" --cert "$INTERCOM_BRIDGE_CERT" --key "$INTERCOM_BRIDGE_KEY" \
    -X "$1" -H 'Content-Type: application/json' ${3+--data "$3"} "$INTERCOM_BRIDGE_URL$2"
}
```

| Route                   | Request                                                   | Result                                                                          |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST /v1/register`     | `{}`                                                      | `sessionId`, `name`; other routes register automatically                        |
| `GET /v1/list`          | —                                                         | live peers with unambiguous `target`s                                           |
| `POST /v1/send`         | `{to,message}`                                            | `id`, `accepted`, `delivered`                                                   |
| `POST /v1/ask`          | `{to,message,timeoutMs?}`                                 | send receipt and `reply:{from,message}`                                         |
| `POST /v1/reply`        | `{replyTo,message}`                                       | send receipt to the ask's saved sender                                          |
| `GET /v1/inbox`         | `?after=CURSOR&limit=1..256`                              | `messages`, `nextCursor`, `hasMore`, `overflow`, `lostMessages`, `storageError` |
| `POST /v1/ack`          | `{ids:[...]}`, at most 256                                | `acked`, `retained`                                                             |
| `POST /v1/broadcast`    | `{message,group?}`                                        | `status`, per-target `receipts`, member `errors`                                |
| `GET /v1/groups`        | —                                                         | this identity's `groups`                                                        |
| `POST /v1/groups`       | `{name,members:[...]}` or `{name,match}`                  | upserted `groups`                                                               |
| `GET /v1/sessions`      | `?live=true&saved=true&q=&offset=&limit=`                 | `sessions`, `nextOffset?`, `liveTruncated?`                                     |
| `POST /v1/spawn`        | `{name,cwd?,task?,model?}`                                | `session`, `id`, `reused`, `task?`                                              |
| `POST /v1/resume`       | `{target,task?}`                                          | `session`, `id`, `reused`, `task?`                                              |
| `POST /v1/stop`         | one of `sessionId`, `target`, `to`; `mode?`, `timeoutMs?` | see [Stop and cancel](#stop-and-cancel)                                         |
| `POST /v1/cancel`       | one of `sessionId`, `target`, `to`; `timeoutMs?`          | same as `stop` with `mode:"cancel"`                                             |
| `GET /v1/transcript`    | `?target=&limit=&maxBytes=&cursor=&timeoutMs=`            | live or saved transcript page; see [Transcripts](#transcripts)                  |
| `POST /v1/transcript`   | `{to,limit?,maxBytes?,cursor?,timeoutMs?}`                | same as `GET /v1/transcript`                                                    |
| `POST /v1/capabilities` | `{to,timeoutMs?}`                                         | native capabilities receipt                                                     |
| `POST /v1/control`      | `{to,verb,options?,timeoutMs?}`                           | native control receipt; `verb:"transcript"` behaves like `/v1/transcript`       |
| `POST /v1/start`        | `{name}`                                                  | legacy idle launch in the identity `cwd`                                        |

Ask waits up to two minutes (`timeoutMs` 100–120000) for the exact recipient and `replyTo`; each identity has one outgoing ask at a time. A timeout doesn't retract a delivered ask, and a late answer arrives in the inbox. Spawn, resume and transcript lookup have a 75-second helper deadline (90 seconds in the CLI); ask has its timeout plus 15 seconds; other routes have 15 seconds. Live transcript controls keep their separate native response deadline; saved name lookup may scan the full catalog.

### Mailbox, presence and wake

**Intake.** Every message addressed to the identity is committed to its SQLite mailbox (full synchronous writes) before the helper surfaces it or completes a waiting ask. Unread mail and unanswered asks survive helper crashes, restarts and broker outages. There is no retention limit, so monitor disk space. If a write fails, the mailbox records `overflow`, `lostMessages` and `storageError`. If the loss itself can't be recorded, requests return 507 `mailbox_storage_failed` and the audit log shows `lossRecorded:false`.

**Reading.** `GET /v1/inbox` returns a non-destructive page of at most 256 messages and 4 MiB. Keep reading with `after=nextCursor` while `hasMore` is true; start again from `0` to revisit unacked mail. The cursor is an opaque sequence number. Inbox and ack work while the broker is down.

**Acknowledging.** Ack an ordinary message to delete its payload; its ID stays as a tombstone so replays are ignored. Ack an ask to record that you've stored it: it appears in `retained`, stays in the inbox as a reply obligation and never triggers a fallback wake. A successful `reply` retires the ask. Reply goes to the ask's saved sender ID; if that sender is offline, it returns `peer_offline` and keeps the obligation. Ack is idempotent. In persistent mode, an answer returned by `ask` is also kept in the inbox; ack `reply.message.id` once you've consumed it.

**Presence.** After the first authenticated connection, the helper writes a private presence proof (identity, `cwd` and certificate expiry) to `stateDir` and keeps the identity registered with the broker, refreshing every 15 seconds. It stays registered without remote polling until the certificate expires, the identity changes or is revoked, or the helper stops. A restarted helper restores presence from that proof without any remote request. A revoked identity is never restored.

**Primary wake.** The remote consumer owns waking its agent. Poll the inbox, for example every 15 seconds; append each message to durable storage and fsync it; only then ack it. A crash before the ack replays the message, so deduplicate by `message.id`.

**Fallback wake.** If a message stays unacked for at least 120 seconds, the helper POSTs one wake for the oldest such message to `GROK_WAKE_WEBHOOK_URL` with `Authorization: Bearer <GROK_WAKE_WEBHOOK_KEY>` and this body:

```json
{
  "from": "sender name",
  "from_id": "pi-…",
  "to": "fitch-os",
  "message_id": "…",
  "ask_id": null,
  "text": "…"
}
```

`ask_id` is the message ID for asks. A 2xx response is logged as `accepted`, but it can't prove the consumer stored the message, so the wake stays pending: the helper posts the same oldest unacked message again every 5 minutes until the consumer acks it. Acking an ask counts. Deduplicate wakes by `message_id`. Other responses and transport failures retry with doubling backoff up to 5 minutes. Redirects are refused, each request times out after 10 seconds, and the helper sends at most one wake per cycle. Fallback stops while the identity is revoked or its certificate has expired.

### Sessions

`GET /v1/sessions?live=true&saved=true` returns rows of `id`, `sessionId`, `peerId`, `name`, `cwd`, `status`, `lastSeen`, `saved` and `owned`. `owned` is true only for this identity's current helper subprocesses. Saved rows require `launch` policy and come from `sessionDir` and `resumeDirs`; rows never include journal paths or transcript bodies. `q` filters ID, name and cwd. `limit` is 1–100 (default 50). `offset` and `nextOffset` are filesystem candidate cursors, with at most 1,000 candidates scanned per request, not row counts. `liveTruncated` means live-only peers didn't fit; page them with `live=true` alone. A bare `GET /v1/sessions` keeps the legacy list of this identity's owned processes, including PID and journal path.

```bash
api GET '/v1/sessions?live=true&saved=true&limit=50'
api POST /v1/spawn '{"name":"reviewer","cwd":"/Users/you/src/app","task":"Review the current branch and reply with findings.","model":"provider/model-id"}'
api POST /v1/resume '{"target":"NATIVE_SESSION_ID","task":"Continue where you left off."}'
```

**Spawn** creates a session named `remote:IDENTITY:NAME` in `cwd` (default: the identity `cwd`). `model` is `provider/id`, split at the first slash; you can also send `provider` and `model` separately. The helper writes a new 0600 journal containing the launch context without running inference, starts Pi idle in RPC mode, and waits for readiness. It then sends `task` as an ordinary Intercom message from the identity, so the session's replies land in the mailbox. `task:{id,accepted,delivered,completed:false}` is broker acceptance. A live session with the same name is reused (`reused:true`), or rejected with `cwd_conflict` or `model_conflict` when those differ. If the task send fails, the error includes the live `session`; deliver the task with `/v1/send` instead of spawning again. After a lost response, check sessions or repeat the same name.

**Resume** takes `target` (or exactly one of `sessionId` or `name`) plus an optional `task`. A target matches an exact native session ID or peer ID first, then a unique saved name. Name lookups scan the whole catalog to prove uniqueness and fail rather than accept a partial match. Resume reuses a live owned process, then a live Intercom peer proven to own that journal, without reopening the journal. Otherwise it opens the original journal in place, with the same session ID, cwd, name and history, and restores the recorded model. If Pi falls back to a different model, resume fails with `model_restore_failed` and submits no task. It refuses with `active_session` when a live peer matches the name and cwd but can't be proven to own the journal. A process that resume starts is helper-owned.

Duplicate-writer protection covers helper-owned startups and discoverable Intercom peers. Pi's `SessionManager` has no cross-process journal lock, so a Pi process without Intercom, or one that hasn't published its peer yet, is invisible to the bridge. The helper never adopts processes after a restart. A surviving child that is still a live Intercom peer is reused by resume rather than reopened.

### Stop and cancel

Both routes take exactly one of `sessionId`, `target` or `to`. `stop` also takes `mode`: `kill` (default) or `cancel`. `POST /v1/cancel` is `stop` with `mode:"cancel"`. The helper first looks for this identity's helper-owned process by native session ID, peer ID or name. Only when the identity owns no match (`unknown_session`) does it send a native control to a live Pi, with `timeoutMs` 100–10000 (default 3000). Any other failure, including an unknown outcome, is returned as is and never redirected. Ownership decides what the bridge can guarantee:

| Target                                       | `mode: "cancel"`                                                                                                                                           | `mode: "kill"` (default)                                                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This identity's helper-owned process         | Native RPC abort. Returns after observed idle with `queuesPreserved:true` and the pending count, or `cancel_unconfirmed`. Future Intercom tasks still run. | Closes stdin and signals the private process group (TERM after 1 s, KILL after 3 s). Returns `status:"exited"` only after observing exit within 8 seconds; otherwise `stop_timeout`, so retry. The journal is kept. |
| Any other live Pi with the updated extension | Native control `cancel_requested`: the current operation is aborted and accepted queued input is kept (`queueCleared:false`).                              | Native shutdown request: `shutdown_requested`, or `unsupported` while still requesting shutdown and abort. Always `processExited:false`.                                                                            |

For other sessions, TUI shuts down in order, idle RPC waits for its next command, and print or JSON modes report `unsupported`. A disconnect doesn't prove exit, and detached background jobs keep their own lifecycle. The bridge never signals another process by PID and never stops the broker.

**Native controls** travel as passive, typed Intercom messages. Before acting, the recipient checks that the sender is `remote-<fingerprint>` and that the TLS certificate chain supplied by the bridge is current, issued by the configured CA and pinned in its policy file, then replies with a correlated result. A Pi process still running older extension code receives only a short passive note; the request then fails with `control_unconfirmed` and `deliveryUnknown:true`. Don't retry automatically. Use `POST /v1/control` with `verb` `capabilities`, `cancel`, `stop` or `transcript` for the direct form; it skips the owned-process lookup. `timeoutMs` is 100–10000 (default 3000), with at most eight controls in flight per identity.

### Transcripts

`GET /v1/transcript?target=TARGET&limit=20`, `POST /v1/transcript {to,...}` and `POST /v1/control` with `verb:"transcript"` read the same way. The helper first resolves the target against live Intercom peers:

- **Live.** A live Pi with the updated extension answers through native control. The result is the control receipt plus `source:"live"` and `transcript`, the page (also still at `native.transcript`). A live Pi running older extension code fails with `control_unconfirmed`; the helper doesn't fall back to its journal.
- **Saved.** Only when no live peer matches (`peer_offline`) does the helper read the saved journal. That requires `launch` policy (otherwise 403 `launch_disabled`). The target resolves through the saved catalog by stable ID or unique name, and the result is `{status:"ok", source:"saved", session, transcript}`. The journal is parsed read-only with the identity's `packageRoot` and is never opened for writing or migrated. Saved reads reject journals over 64 MiB or 50,000 entries, ignore an unfinished trailing record, and fail with 409 `session_changed` if the journal's session ID changes during the read.

A page holds `records` (`id`, `timestamp`, `role`, `text`, `truncated`) in chronological order. Only finalized user, assistant, tool-result and custom text on the active branch is included; thinking, images, tool arguments, and system or provider data are not, and streaming output isn't available. Defaults are 50 records and 64 KiB, with maximums of 100 records and 128 KiB (`maxBytes` minimum 256). A read scans at most 1,024 entries and reports `scanLimitReached`. `cursor` continues to older output while the selected branch is unchanged.

### Groups and broadcast

```bash
api POST /v1/groups '{"name":"app","members":["reviewer","pi-0123456789abcdef0123456789abcdef"]}'
api POST /v1/groups '{"name":"workers","match":"remote:fitch-os:*"}'
api POST /v1/broadcast '{"group":"workers","message":"Report status."}'
```

Groups are upserted by name and private to the certificate fingerprint, stored in `stateDir` (or `$PI_CODING_AGENT_DIR/intercom/bridge-state`, created 0700, when `stateDir` is unset). Each identity can have 64 groups of up to 256 explicit members, within 1 MiB. `match` is a name glob or `{id?, nameglob?, cwd?}`; the canonical fields are `members`, `namePattern` and `cwdPattern`. Explicit members are unioned with glob matches, and when both globs are set a peer must match both. Globs use Node's `path.matchesGlob`.

Broadcast resolves current live Pi sessions, excluding remote identities, and deduplicates them. Without `group` it targets every live Pi session. Each target is sent once, sequentially, with its own receipt or error. Offline or ambiguous members appear in `errors`, and any failure makes `status` `partial`.

If the broker stalls or disconnects mid-broadcast, the HTTP request fails (`ok:false`) but retains `status:"partial"`, all per-target `receipts` and member `errors`. A receipt with `accepted:true` is confirmed; an in-flight failure carries its message `id` and `deliveryUnknown:true`; targets not sent have `attempted:false` and `deliveryUnknown:false`. Revocation or certificate expiry denies the response instead. Nothing is retried automatically. Resend only definite failures or unattempted targets; inspect unknown outcomes before deciding whether to resend.

## Update and roll back

**Helper.** Install a new release (step 1), point `current` at it, then restart gracefully:

```bash
ln -sfn "$RELEASES/NEW_RELEASE" "$RELEASES/current"
launchctl kill SIGTERM "gui/$(id -u)/$LABEL"
```

To roll back, point `current` at the previous release and restart the same way. A restart stops the helper's owned sessions; their journals remain, so resume them afterward. Mailboxes, presence proofs and groups persist. Delete an old release only when no helper or broker process still runs from it, because a broker started by the helper runs from that release.

**Pi extension.** Update Pi's own installation by following the [installation guide](reference.md#installation), and never overwrite extension files that a running Pi has loaded. New Pi processes use the newly selected extension. Each existing process keeps the code it loaded and gains native controls only after it adopts the update at a safe boundary: finish or checkpoint its work, quit, and resume the same saved session with `pi --session PATH`. Until then it stays messageable and listed, but controls to it fail with `control_unconfirmed`. The bridge can't force old processes to reload and doesn't kill them.

## Credentials

**Rotate a client.** `issue` always creates a new fingerprint, keeps the identity's `launch` and `wake` policy, and replaces the old pin. Don't run it for a long-lived certificate you mean to keep.

```bash
node "$PKG/scripts/intercom-bridge-credentials.mjs" issue "$BRIDGE" fitch-os --days 3650
launchctl kill SIGHUP "gui/$(id -u)/$LABEL"
```

Copy the new certificate and key to the remote host. After the reload, the old certificate is denied and its owned sessions stop. Mailboxes, presence proofs and groups are keyed by fingerprint, so the new certificate starts empty; the old files stay on the Mac for local recovery.

**Renew the server certificate.** The server certificate from `init` lasts one year. Before it expires, reissue it from the same CA and restart the helper, because SIGHUP can't change TLS files:

```bash
node "$PKG/scripts/intercom-bridge-credentials.mjs" renew-server "$BRIDGE" --days 3650
launchctl kill SIGTERM "gui/$(id -u)/$LABEL"
```

`renew-server` takes no identity name or `--cwd`. `--days` is 1–3650 (default 365). It writes a new `server-<hex>` key and certificate and points `cert` and `key` in `config.json` at them. The CA, client certificates and pins don't change, so remote hosts need nothing new. Check any certificate with `openssl x509 -noout -enddate -in FILE`; the CA itself expires ten years after `init`.

**Revoke.**

```bash
node "$PKG/scripts/intercom-bridge-credentials.mjs" revoke "$BRIDGE" fitch-os
launchctl kill SIGHUP "gui/$(id -u)/$LABEL"
```

Confirm the `allowlist_reloaded` record, that the identity has left the peer list, and that its certificate can't call `/v1/list`. Revocation also stops its owned sessions and fallback wakes. For an immediate cut-off, `bootout` the helper or withdraw the Tailscale Serve port. If the CA key is compromised, start over with a new `init`.

Credential commands hold `DIR/.credentials.lock` for the whole update and fail rather than overwrite each other. After a crash, confirm the PID in `DIR/.credentials.lock/owner` has exited before removing the lock.

## Recovery

| Symptom                                                     | What to do                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS handshake fails from the remote host                    | Check client, server and CA expiry; the remote forwarder; `tailscale serve status`; and the helper's `listening` record.                                                |
| Local peers get `peer_offline` for the remote identity      | The helper is stopped or the certificate expired or was revoked. A restarted helper re-registers from a valid presence proof; otherwise one authenticated request does. |
| `broker_unavailable`, or a refusal to start a second broker | Let the unhealthy broker exit, or start a normal Pi session, then retry. Don't delete broker files or kill a working broker.                                            |
| 507 `mailbox_storage_failed`                                | Fix disk space or `stateDir` permissions, then restart the helper. `lossRecorded:false` audit records mark uncounted losses.                                            |
| No fallback wakes                                           | Check `wake_delivery` records (`http_rejected` with status, `transport_unconfirmed`, `storage_unavailable`) and the env file's mode and URL. Acked messages never wake. |
| Repeated wakes for one `message_id`                         | Expected every 5 minutes after an `accepted` wake until the consumer acks the message. Fix the consumer's store-then-ack loop.                                          |
| Lost response, `task_unconfirmed` or `control_unconfirmed`  | The outcome is unknown. Inspect the inbox, sessions or peer before retrying.                                                                                            |
| `launch_in_progress` or `stop_timeout`                      | Inspect `GET /v1/sessions`; retry stop until it reports `exited`.                                                                                                       |
| `allowlist_reloaded` with `failed_closed`                   | The config is invalid; every identity is denied and owned sessions stopped. Fix the config and send SIGHUP again.                                                       |

## Verification

The process-boundary tests use a private real broker, real certificates, real HTTPS and the remote CLI. Launch tests use the installed Pi dependency graph with a native faux provider, so no paid inference or external credentials are needed. Coverage includes cold SIGKILL restarts with mailbox and presence recovery, delayed fallback wakes and ack suppression, bounded cursor drains, storage failures, spawn and resume identity and model preservation, owned cancel and observed exit, native control authorization and old-owner timeouts, live transcripts and the saved-journal reader, same-CA server renewal with an unchanged client key, and restart-persistent groups.

```bash
node --test test/integration/intercom-bridge.test.ts test/integration/intercom-bridge-delivery.test.ts \
  test/integration/intercom-bridge-launch.test.ts test/integration/intercom-bridge-lifecycle.test.ts \
  test/integration/intercom-native-control.test.ts test/unit/intercom-transcript.test.ts
env -u PI_TIMING -u PI_EXTENSION_PERFORMANCE npm run ci
```

For a live smoke test from the remote host, run `list`, ask one deliberately chosen session to reply `bridge-smoke-ok`, and fetch `GET /v1/sessions?live=true&saved=true`. Pause the remote consumer for more than two minutes to confirm a fallback wake. Keep only a redacted record: platform, route, accepted or delivered flags and the reply text. Never publish config, keys, wake URLs or raw inbox and list output.
