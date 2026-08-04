# Visible Peer Sessions

Read this only before starting a new visible Pi session for pi-intercom coordination.

## Decision rule

Start a peer only when all are true:

- `intercom({ action: "list" })` shows no connected session that already fits.
- The work benefits from a long-lived visible conversation.
- The peer is in the same repo or a deliberate reference repo.
- You can smoke-test delivery before sending real work.

Do not spawn peers for trivial questions, unrelated repos, or work the current session can finish.

## Preflight

```bash
command -v tmux
pi --help | rg -- '--name|--extension|--skill'
```

Use a private `tmux` socket so the peer is isolated and easy to clean up. If a visible split tool is installed and already preferred by the user, check that tool's current help before using it.

## tmux same-repo peer

```bash
SOCKET="${TMPDIR:-/tmp}/pi-intercom-tmux.sock"
SESSION="pi-worker"
tmux -S "$SOCKET" new -d -s "$SESSION" -c "$PWD" 'pi --name worker'
tmux -S "$SOCKET" attach -t "$SESSION"
```

## tmux local-fork dogfood peer

Run from the pi-subagents package checkout when testing the bundled intercom extension without installing it globally:

```bash
SOCKET="${TMPDIR:-/tmp}/pi-intercom-tmux.sock"
SESSION="pi-worker"
ROOT="$PWD"
tmux -S "$SOCKET" new -d -s "$SESSION" -c "$ROOT" "pi --name worker --extension \"$ROOT/src/pi-intercom/index.ts\" --skill \"$ROOT/skills/pi-intercom\""
tmux -S "$SOCKET" attach -t "$SESSION"
```

## Smoke test

After the peer starts:

```typescript
intercom({ action: "list" })
intercom({ action: "send", to: "worker", delivery: "steer", message: "Smoke test: send exactly OK back to this session with delivery steer." })
```

Expected reply:

```text
OK
```

## Cleanup

If a tmux peer is no longer needed:

```bash
tmux -S "$SOCKET" kill-session -t "$SESSION"
```

If you leave a peer running, tell the user its session name and how to attach or close it.
