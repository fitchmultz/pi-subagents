# Active-child viewer real-PTY acceptance

This opt-in driver verifies the viewer at the native terminal boundary: real tmux PTY,
real CLI, the deterministic observe fixture, and the actual child runner. It complements
`test/integration/agent-observe.test.ts` (native InteractiveMode with a replaced terminal),
which cannot establish PTY input, SIGWINCH, or child-process lifetime.

Run it with the physical Node executable. `--source` selects extension source;
`--host` selects a Pi package root. The output directory must not exist.

```sh
/Users/mitchfultz/.local/share/mise/installs/node/24.22.1/bin/node \
  test/support/active-child-viewer-pty.ts \
  --source /Users/mitchfultz/Projects/worktrees/pi-subagents/active-child-viewer \
  --host /Users/mitchfultz/Projects/worktrees/pi-subagents/active-child-viewer/node_modules/@earendil-works/pi-coding-agent \
  --output /tmp/pi-viewer-pty-fullscreen-official \
  --mode fullscreen
```

Use `--mode regular` for the non-fullscreen TUI. Qualify the intended fork separately by
passing its package root as `--host`; a matching version number does not establish it.

Add `--managed` to test the packed package boundary instead of direct source loading. The
driver runs `npm pack`, installs the tarball's runtime dependencies, installs the extracted
package into the isolated Pi home, and launches the CLI with package discovery enabled and
no `-e` source entry. This catches missing packaged files, peer-resolution differences, and
extension-discovery failures that the direct source path cannot.

```sh
/Users/mitchfultz/.local/share/mise/installs/node/24.22.1/bin/node \
  test/support/active-child-viewer-pty.ts --managed \
  --source /Users/mitchfultz/Projects/worktrees/pi-subagents/managed-viewer-gate \
  --host /Users/mitchfultz/Projects/worktrees/pi-subagents/managed-viewer-gate/node_modules/@earendil-works/pi-coding-agent \
  --output /tmp/pi-viewer-managed-official --mode fullscreen
```

Managed acceptance passed both modes on official Pi 1.4.0 and the intended fork: 53 checks
each, zero failures, with the native completion audit and process cleanup intact. Managed
fullscreen idle CPU was 0.21 s open vs 0.08 s closed on official and 0.25 s vs 0.18 s on
the fork over 4 s.

## Scenario

The parent delegates `watch-child 雪`; the child publishes `CHILD_TEXT_LIVE 雪😀` and
holds `observe_gate`, which streams progress from the `progress-child` control file.
The parent is held in its follow-up provider response until `release-parent`. The driver:

1. opens `/agents`, selects the child, and asserts live text, a live tool card, and
   `Following live`;
2. samples idle CPU and terminal output with the viewer open (4 s, no updates);
3. streams eight progress updates and samples CPU and output;
4. scrolls up (suspends follow), writes another update, and asserts the anchored row did
   not move; End resumes follow and the new update is visible;
5. pages up twice and asserts the conversation never blanks, then returns live;
6. resizes to 46x18 and back, asserting the live progress row stays visible;
7. opens `ctrl+p` details, asserts the assignment preview, and closes it;
8. closes the reading view, samples idle CPU/output with the viewer closed, and reopens it,
   asserting live text reconnects and follow resumes;
9. releases the child, asserts the canonical final text appears without
   `Awaiting journal publication` and the active row stops showing running;
10. runs the native busy/idle checkpoint, releases the parent, verifies the native
    completion audit (3 parent / 2 child requests), and quits cleanly.

## Evidence

`report.json` records status, every check, failures, cleanup, limitations and
`metrics` (per-window `cpuSeconds` from `ps -o time=`, `terminalBytes` growth from the
tmux `pipe-pane` raw output, and `windowMs`). Numbered `.txt`/`.ansi` files are
tmux-native screen captures; `terminal.raw` is continuous pane output. `identity.json`
records the source commit and dirty state, Node, host paths/version, machine, mode and
SHA-256 identities. `sessions.jsonl`, `requests.jsonl`, `request-audit.json` and the
native run directory retain the actual journals and provider requests.

Acceptance assertions in the driver: idle CPU while open stays within 0.6 s of idle CPU
while closed, and open idle adds at most 8 KiB of terminal output over the 4 s window;
eight live updates stay within four CPU seconds; suspended follow does not move the
anchored row; the conversation never blanks while paging at the top; settling is not
presented as running or awaiting publication.

## Limits

One deterministic child and one execution per host/mode. This is a bounded acceptance
run, not a profile: CPU deltas are cumulative process time, terminal bytes include
normal Pi polling and the whole smoke, and the measurement window is short. The child
history is short, so durable multi-page paging is covered by the native integration
test; this driver proves the PTY boundary for live view, follow, resize, details,
reopen and settlement. No event-loop, memory, file-read or network metric is collected.

Managed mode installs a locally packed and extracted package, not a remote git/npm
checkout. It verifies packaged contents and discovery, but does not exercise the registry
or package-manager update path.
Offline and an allowlisted empty-credential environment prevent ordinary provider use.
