# Secure remote Intercom bridge

Optional HTTPS messaging proxy for a remote agent such as **Grok Bot**. Pi-intercom's broker remains same-machine Unix IPC. Nothing is added to the Pi extension loader, and starting Pi alone never starts this proxy.

## Design note

**Transport:** a Mac-local Node HTTPS server bound to **127.0.0.1**, carried by a Mac-initiated **SSH reverse TCP forward** to the Linux box's loopback interface. Grok calls HTTPS on its own loopback. Unlike a Unix-socket tunnel, only the proxy opens `broker.sock`; neither the remote nor SSH can issue raw broker frames. This choice needs no cloud account, public DNS, inbound Mac SSH, or per-call laptop approval. An existing SSH account on Linux is the only tunnel prerequisite. SSH authenticates the tunnel host; end-to-end mTLS authenticates both application endpoints even to other processes on Linux.

**Threat model:** deny unauthenticated local/network callers, stolen credentials after revocation/expiry, identity spoofing, arbitrary broker commands, forged replies, accidental LAN exposure, and unbounded waits/resource use. The Mac user, local broker, OS, private CA, and approved remote host are trusted. A compromised authorized Grok credential can read peer metadata and send agent-visible text to local peers (including instructions); mTLS does not sandbox those agents or make the content trustworthy. Listed peers can be in other projects. Approve only a host allowed to see that metadata and message those peers. Root/compromised endpoints and denial of service beyond fixed connection/request limits are outside this boundary.

**Auth/authority:** TLS 1.2+ with client certificates issued by a private CA **and** an explicit SHA-256 certificate fingerprint allowlist. Each allowlisted certificate fixes the peer name and Mac project directory; remote payloads cannot change identity, cwd, socket, shell commands, or presence. Certificates last seven days. TLS verifies the server CA and loopback SAN; never use `curl -k` or disable certificate checks. The proxy exposes only register/list/send/ask/reply, plus inbox/ack receipt plumbing needed to receive messages and answer local asks. No broker admin, topic operations, file reads, or shell endpoint.

**Socket discovery:** reuse the actual `IntercomClient`, `getBrokerSocketPath()` and framing code. With the same Mac uid, `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) and `TMPDIR` as Pi, the preferred path is `$TMPDIR/pi-intercom-<sha256(uid:agentDir)[0:16]>/broker.sock`; long paths fall back to `/tmp`. The client's existing owned-socket legacy fallback is retained. No hardcoded `/var/folders` path, chmod, broker spawn, PID-file operation, or broker restart. An unavailable broker returns an error; start a normal Pi session to bring it up.

**Delivery/lifecycle:** one broker peer per authorized certificate, registered lazily on the first API call, with a five-minute inactivity lease. Poll inbox to maintain presence. Send returns broker acceptance, not proof a model consumed it. Ask steers the recipient and waits at most two minutes for both the exact recipient ID and exact `replyTo`. One outgoing ask per identity. Revocation/expiry/shutdown/client disconnect terminate waits. Inbox is bounded and volatile; overflow is reported, not silently described as successful receipt. Restarting the helper loses inbox contents and pending replies. Upgrade to a durable inbox journal if restart recovery is required; existing Pi recipients still save their own messages normally.

**Audit:** JSONL metadata on stdout: request/connection identity, certificate fingerprint, operation, peer/message IDs and outcome. Message/attachment bodies and keys are not logged. Protect logs (0700 directory, 0600 files); rotate them with your normal log tooling. Never publish private config/keys or raw inbox/list output as smoke evidence.

## Mac setup

Requires Node **24.21.0+**, OpenSSL with `req -addext` (Homebrew OpenSSL works), and a connected Pi session with Intercom. Run commands from this checkout/package directory. A runtime-only installed checkout already has `dist/`; for development use `npm ci` first. See the [installation guide](../README.md#installation) before rebuilding an in-use extension. This standalone helper can run from its own installed copy without touching the live Pi runtime.

```bash
# Use a NEW directory; init refuses to overwrite any existing CA.
umask 077
BRIDGE="$HOME/.pi/intercom-bridge"
node scripts/intercom-bridge-credentials.mjs init "$BRIDGE" --cwd "$PWD"
```

The last JSON line contains paths to the issued client `cert`/`key`, trusted `ca`, and `config`; it does not print secret contents. Keep those paths for the copy step. Configuration is local-only, owned by the Mac user and private:

```json
{
  "port": 9443,
  "ca": "/Users/mitch/.pi/intercom-bridge/ca.crt",
  "cert": "/Users/mitch/.pi/intercom-bridge/server.crt",
  "key": "/Users/mitch/.pi/intercom-bridge/server.key",
  "clients": [
    {
      "fingerprint256": "SHA256_FINGERPRINT_FROM_ISSUE",
      "name": "grok-bot",
      "cwd": "/Users/mitch/project"
    }
  ]
}
```

`cwd` controls presence/project association, **not** an authorization restriction. `list` intentionally returns all connected peer identities, omitting topics/subscriptions. Target full IDs or the returned `target` when names collide. Port `0` requests an ephemeral port, reported in the listening log; a fixed port is easier for SSH.

Start the helper in a dedicated terminal (or supervise this exact command with launchd):

```bash
# Match Pi's agent directory and temp environment, especially for launchd.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"
node dist/pi-intercom/bridge.js --config "$BRIDGE/config.json" >> "$BRIDGE/audit.jsonl"
```

The listening record includes the helper PID and port. Record the PID as `HELPER_PID` in your administration terminal; **do not use the broker PID**. Wait for that readiness record before making a request: a running process is not proof its listener is ready. Verify `lsof -nP -iTCP:9443 -sTCP:LISTEN` shows only `127.0.0.1:9443`. Keep the helper running; no per-message approvals are needed.

For the installed Mac LaunchAgent (`com.fitchmultz.pi-intercom-bridge`), inspect and administer it with:

```bash
launchctl print "gui/$(id -u)/com.fitchmultz.pi-intercom-bridge"
# Reload allowlist without restarting:
launchctl kill SIGHUP "gui/$(id -u)/com.fitchmultz.pi-intercom-bridge"
# Stop immediately; remove the plist too to disable future login starts:
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.fitchmultz.pi-intercom-bridge.plist"
# Start again explicitly:
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.fitchmultz.pi-intercom-bridge.plist"
```

The installed agent has no `KeepAlive` auto-restart; stopping its helper really stops access. Remove its plist to disable future login starts permanently. Inspect/drain inbox before a planned helper restart because it is volatile.

### Tunnel and provision Grok

Use the **known, approved** Linux SSH host/account, not an invented example host. Preserve SSH host-key verification and do not forward your SSH agent:

```bash
GROK_SSH='grok@YOUR_LINUX_HOST'
# On Linux, first inspect effective SSH config with the administrator:
# sudo sshd -T | grep gatewayports
# Require GatewayPorts=no (default) or clientspecified, NEVER yes.

# On the Mac, dedicated terminal/supervised process:
ssh -NT -a -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:9443:127.0.0.1:9443 "$GROK_SSH"
```

**On Linux, verify `ss -ltn '( sport = :9443 )'` shows only `127.0.0.1:9443` before use.** `GatewayPorts=yes` forces wildcard binding even when `-R` requests loopback. If it shows `0.0.0.0`, `*`, or `[::]`, stop the tunnel and correct that SSH policy. Do not open a firewall port. OpenSSH references: [ssh `-R`](https://man.openbsd.org/ssh.1) and [sshd `GatewayPorts`](https://man.openbsd.org/sshd_config.5#GatewayPorts).

Transfer **only** the client certificate/key, public `ca.crt`, and the dependency-free remote script through the existing approved SSH/SFTP channel:

```bash
# Use cert/key paths printed by init/issue, not the CA or server keys.
CLIENT_CERT='/absolute/path/from/issue/grok-bot-ISSUED.crt'
CLIENT_KEY='/absolute/path/from/issue/grok-bot-ISSUED.key'
ssh "$GROK_SSH" 'umask 077; mkdir -p ~/.config/pi-intercom; chmod 700 ~/.config/pi-intercom'
scp "$CLIENT_CERT" "$GROK_SSH:.config/pi-intercom/client.crt"
scp "$CLIENT_KEY" "$GROK_SSH:.config/pi-intercom/client.key"
scp "$BRIDGE/ca.crt" scripts/intercom-remote.mjs "$GROK_SSH:.config/pi-intercom/"
ssh "$GROK_SSH" 'chmod 600 ~/.config/pi-intercom/*'
```

For a least-privileged dedicated Linux SSH tunnel account, the administrator can restrict its key to remote forwarding with `restrict,port-forwarding,permitlisten="127.0.0.1:9443",command="/bin/false"` and `AllowTcpForwarding remote`, `GatewayPorts no`. `-N` requests no shell. Provision files separately; do not reuse Grok's client key as an SSH key. No SSH login credential for the Mac is given to Grok.

## Grok Bot: exact remote commands

On Linux, configure Grok's shell environment:

```bash
export INTERCOM_BRIDGE_URL='https://127.0.0.1:9443'
export INTERCOM_BRIDGE_CA="$HOME/.config/pi-intercom/ca.crt"
export INTERCOM_BRIDGE_CERT="$HOME/.config/pi-intercom/client.crt"
export INTERCOM_BRIDGE_KEY="$HOME/.config/pi-intercom/client.key"
REMOTE="$HOME/.config/pi-intercom/intercom-remote.mjs"

node "$REMOTE" register
node "$REMOTE" list
node "$REMOTE" send --to planner --message 'Grok checking in. Please send your current status.'
node "$REMOTE" ask --to planner --message 'What is the current status?' --timeout-ms 120000
node "$REMOTE" inbox
node "$REMOTE" reply --reply-to QUESTION_ID_FROM_INBOX --message 'Proceed with the stable API.'
node "$REMOTE" ack ORDINARY_MESSAGE_ID_FROM_INBOX
```

Poll inbox at a reasonable cadence (for example every 5–15 seconds) while Grok is available. Fetch is non-destructive, so retrying a fetch cannot lose messages; persist/consume then ack ordinary messages. Inbound asks remain in the inbox until `reply` succeeds; ack does not discard a reply obligation. Use `send` for most coordination and `ask` only when Grok really needs a blocking answer. The CLI has a hard request deadline (ask timeout + 15 seconds), validates TLS, emits JSON, and exits 1 on errors / 2 on invalid arguments. It never retries mutations automatically.

Curl works too, with bounded waiting and the same TLS files:

```bash
curl --fail-with-body --max-time 135 \
  --cacert "$INTERCOM_BRIDGE_CA" --cert "$INTERCOM_BRIDGE_CERT" --key "$INTERCOM_BRIDGE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"to":"planner","message":"Please reply with your status.","timeoutMs":120000}' \
  "$INTERCOM_BRIDGE_URL/v1/ask"
```

### JSON API contract

All routes require mTLS and the certificate allowlist. Unknown routes/fields, wrong methods, non-JSON bodies, unsafe control characters, and requests larger than 64 KiB are rejected. No CORS; browser-origin requests are rejected. Success is `{ "ok": true, ... }`; application failures are `{ "ok": false, "error": { "code": "...", "message": "..." } }` with a non-2xx status. Certificate/allowlist admission can terminate TLS before HTTP; the CLI reports that as a TLS/transport error. No remote-controlled broker frame or command is passed through.

| Route               | Request                   | Success fields                                           |
| ------------------- | ------------------------- | -------------------------------------------------------- |
| `POST /v1/register` | `{}`                      | `sessionId`, `name` (also automatic on other operations) |
| `GET /v1/list`      | none                      | `sessionId`, `sessions` (metadata + unambiguous targets) |
| `POST /v1/send`     | `{to,message}`            | `id`, `accepted`, `delivered`                            |
| `POST /v1/ask`      | `{to,message,timeoutMs?}` | send receipt and `reply:{from,message}`                  |
| `GET /v1/inbox`     | none                      | `messages:[{from,message}]`, `overflow`, `lostMessages`  |
| `POST /v1/reply`    | `{replyTo,message}`       | send receipt; target derived from the received ask       |
| `POST /v1/ack`      | `{ids:[...]}`             | `acked`, `retained`                                      |

Timeout does **not** retract a delivered ask; a late answer can arrive in inbox. Offline/missing peers, broker outages, ambiguous/self targets, a second concurrent ask, invalid/revoked credentials, timeout, and resource limits have explicit errors. HTTP send/list deadlines are bounded by the real client (8/5 seconds); broker registration by 10 seconds. A lost HTTP response or acknowledgement timeout means **delivery unknown**—inspect inbox/local peer before retrying to avoid duplicate instructions.

## Rotate credentials

Client renewal replaces its old fingerprint rather than authorizing both indefinitely. Credential commands hold a private directory lock across the complete config read/modify/write and certificate issuance, so concurrent operations fail instead of restoring a revoked fingerprint. After a crashed command, inspect `DIR/.credentials.lock/owner`, confirm that process is gone, then remove that lock and retry; never clear a live command's lock.

Renew with:

```bash
node scripts/intercom-bridge-credentials.mjs issue "$BRIDGE" grok-bot
# Transfer the NEW cert/key using the same private copy commands above.
kill -HUP "$HELPER_PID"
```

SIGHUP rereads the private config, drops removed/changed peers and their TLS connections, and cancels pending waits. Confirm the reload audit record and verify the old certificate is denied. Invalid reload fails closed. Client expiry also applies to existing connections/peer leases, not just new TLS handshakes. Restart Grok's client process if it caches its files.

Server certificate expires after one year; CA after ten. To rotate server/CA, create a **new** credential directory with `init`, transfer its new public CA and new client credential, stop/restart **only this helper** with the new config, and retain the old directory briefly as a private rollback. Never restart the shared broker or change its socket permissions for rotation. If the CA key is compromised, replace the entire CA immediately. Old private key files retained by `issue` should be removed only when no rollback is needed.

## How to revoke Grok

```bash
node scripts/intercom-bridge-credentials.mjs revoke "$BRIDGE" grok-bot
kill -HUP "$HELPER_PID"
```

Confirm the reload/revocation audit record, that Grok disappears from the local peer list, and that its old cert cannot call `/v1/list`. Stop the SSH forward too if no other client needs it. Remove Grok's saved client key on Linux and obsolete local client keys when no longer needed. Emergency immediate cut-off: stop **the helper process**, not Pi or the broker. Certificate renewal cannot bypass the removed fingerprint; reauthorization requires a new local `issue` + reload.

## Verification / smoke transcript

The process-boundary integration test uses a private real broker, real TLS certificates, actual HTTPS requests and the remote CLI; it requires no model/provider credentials:

```bash
node --test test/integration/intercom-bridge.test.ts
# Do not inject host startup diagnostics into native fixture stderr:
env -u PI_TIMING -u PI_EXTENSION_PERFORMANCE npm run ci
```

For a live smoke, from a separate Mac process and then Linux use the remote CLI to list peers and ask an intentionally selected connected session:

```bash
node "$REMOTE" list
node "$REMOTE" ask --to KNOWN_FULL_SESSION_ID --message 'Bridge smoke only: reply with bridge-smoke-ok.' --timeout-ms 120000
```

Save only a redacted transcript: platform, operation, returned peer names relevant to the test, accepted/delivered, and reply text. Do not publish unrelated cwd/model/topic/message content.

Observed **2026-10-06**, from a separate process on the Mac through the installed runtime-only helper to the live broker and a real connected Pi session (not a mocked recipient):

```json
{
  "platform": "darwin",
  "transport": "loopback HTTPS mTLS",
  "list": { "ok": true, "peers": ["secure-intercom-bridge", "grok-bot"] },
  "ask": {
    "ok": true,
    "accepted": true,
    "delivered": true,
    "replied": true,
    "reply": "bridge-smoke-ok"
  }
}
```

**Off-box deployment/smoke is not yet verified:** the actual Grok Linux SSH destination/access was unavailable. No credentials were transferred to an unverified host. Once that access is supplied, verify Linux's listener and repeat these exact list/ask commands there.
