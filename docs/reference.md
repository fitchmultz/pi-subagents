# Tool reference

The package registers one extension entry and three tools. There are no loader
tools, profile names, generated workflow schemas, or agent-management commands.
The installed tool schemas are authoritative for optional fields.

## `delegate`

```js
delegate({
  prompt: "The complete assignment, including constraints and expected output.",
  name: "optional-readable-name",
  cwd: "/optional/working/directory",
  model: "provider/model",
  context: "fresh",
  async: true,
});
```

`prompt` is required. It is the assignment, not a fragment interpolated into a
canned profile. `name` is an optional display name, not a unique identity or role.
Omitted cwd/model inherit the invoking session's effective selection. A supplied
model must be available; there is no hidden alternate-model retry catalog.

On hosts exporting Pi's native `resolveModelReference`, `model` also accepts
`provider/model:thinking` (for example `provider/model:low` or `provider/model:off`).
The explicit suffix overrides inherited thinking for that child only. Literal
model IDs take precedence, including IDs containing colons or additional slashes;
unknown IDs and invalid suffixes fail without fuzzy matching or another provider.
Native resolution follows Pi's case-insensitive ID matching. Pi still applies the
selected model's native thinking capabilities.

Official Pi 1.3.0 and older fork runtimes do not export that resolver. They retain
case-sensitive literal-ID overrides and inherited thinking; suffix requests fail with an upgrade
message rather than being parsed by an extension-side replacement. This requires
a host with the public resolver export, not merely a matching version number.

Fresh context is the default. Fork uses the native conversation, including
historical tool calls and results; restricting a child's authority does not erase
the parent's evidence. Native Pi system/tool instructions and applicable project
resources still apply. Forking does not authorize nested delegation.

The default response acknowledges launch. It does not claim a model response or
completion. `async:false` waits for this new work. Cancelling that owned foreground
invocation requests stop. Exiting or replacing the parent session stops its
children, including active work, and preserves their saved conversations.

Only a main may delegate. Children cannot bypass the restriction through a hidden
tool or programmatic invocation of `delegate` or `agent_runs`.

## `agent_runs`

Saved runs belong to the native main session that launched them, not its cwd,
project, display name, or a different session forked from its history.

| Action     | Purpose                                                                              |
| ---------- | ------------------------------------------------------------------------------------ |
| `list`     | Page through the current native owner's saved-run metadata, without output previews. |
| `inspect`  | Read one run's immutable result and process/publication facts.                       |
| `continue` | Supply a complete follow-up prompt using the saved child conversation.               |
| `wait`     | Wait for an existing run; cancelling this observer does not stop its producer.       |
| `stop`     | Request termination; inspect the actual process outcome afterward.                   |

All actions except `list` require `id`. Use IDs returned by the tools rather than
infer them from display names. `list` returns at most 50 metadata summaries per
page; follow `nextOffset` to continue. Output is retrieved only by explicit
inspection, not embedded in every inventory row. Inspection of large output returns a continuation
offset; follow that offset until complete. The saved native session and full
output remain available independently of the preview.

Continuation of active work queues guidance. Continuation of completed work
creates an immutable successor in the same conversation. Original handles can
find the latest successor for controls, while inspection preserves predecessor
results. A retained ambiguous launch claim prevents accidental duplicate launch;
missing session state is an error, not permission to start a different chat.
If a handoff saved a run but failed before admission, retry `continue` with the
exact same prompt after its actor and owned shells have exited. This resumes the
saved run and queued command, not another successor. A different prompt is refused
until admission or a canonical result. A missing queued command or ambiguous
process claim requires inspection rather than automatic replay. If the prompt
was lost from context, read its exact value from `launch.json` beside the run's
reported `outputFile`; do not reconstruct or paraphrase it. For adopted legacy
runs, retry using the canonical run ID returned by the existing-successor receipt,
not the retired legacy handle.
Guidance that arrives after its run settles is reported as stale rather than
starting untracked work. Inspection text exposes the guidance command IDs and
admission states, native receipt publication and separately known process exit.
Pending admission is not consumption. Inspect the result and send a new continuation
if guidance became stale; do not infer acceptance from the old completed output.

A completed child can remain alive and messageable while its main remains
attached. Parent exit or session replacement stops its actors and verified owned
native shells, allowing native abort a short grace period before escalation.
Actors also watch for parent death, including a hard kill. Ordinary extension
reload keeps children alive because the parent has not exited.

Resume the same parent and use `continue` with a new prompt to resume a saved
child conversation. This does not replay interrupted tool calls or reconstruct
an execution checkpoint: the child inspects the current work state. Saved
journals and results are retained whether the child was active, stopped or done.

### Evidence levels

Keep these facts distinct:

1. A launch or command was saved/accepted.
2. The child admitted it to its native queue.
3. The relevant native journal entry was fully published.
4. A completed result was produced.
5. The actor process exited with an observed outcome.

Neither a queue receipt nor a stop acknowledgement proves the later levels.
Uncertain process death is reported honestly; it does not synthesize missing tool
results or an exit code. Commands created by tools may have independent process
lifetimes; actor exit alone is not proof that every descendant exited.

Native local bash records process identity before executing the command, allowing
same-owner Stop to clean up its shell group even after an actor crash. This also
supports the recognized `pi-change-working-dir` local bash wrapper without
replacing its cwd/environment behavior. Arbitrary custom or remote bash tools
remain owned by their extensions; the package does not claim cold-crash cleanup
of those external processes.

## `intercom`

Use `list`, `send`, and `last` for normal coordination. `ask`, `reply`, `pending`,
and `status` support request/reply and diagnosis. See [local messaging](intercom.md)
for topology, target resolution, native replay, and delivery distinctions.

### Usage accounting

The parent's token/cost totals are not automatically the entire workflow's spend.
An asynchronous completion notice does not charge child usage to the parent.
Finalized foreground or `wait` collection owns that accounting; repeated collection
does not double-charge the same native contribution. Child journals retain their
own usage. Metadata inventory and the human observer do not repair or collect
accounting; explicit inspection can reconcile pending accounting without itself
charging the parent.

## Completion delivery

Completion notices use steering, not follow-up delivery. A busy parent receives
results at the next native tool boundary; it need not finish its task first.
An idle backlog, including retained legacy results, is published before one wakeup.
This avoids separately deferred settlement wakeups replaying the same result.
New-runtime backlogs are sorted by completion time, then launch time and ID—not
directory order. A later scan cannot reorder messages already admitted to Pi.

Admission is still not publication or model consumption. Native physical receipts
suppress redelivery across reload/resume, and dropped queues can recover. Receipt
polling reuses unchanged verified journal metadata; changed files validate the
committed prefix before parsing appended records. Replacement, truncation, changed
prefixes, malformed records, and missing final newlines do not fabricate receipts.
Completion delivery appends context; it does not replace prior prompts, tools,
model settings, or the active conversation.

## Read-only human observation

Interactive main sessions expose an above-editor widget and `/agents` list/watch.
The widget shows up to five active runs with circle indicators, status and short ID;
unreadable (unavailable) runs also stay listed. The default picker hides completed
runs; failed, stopped, interrupted, and unavailable runs remain visible there.
The header total counts all saved runs; the widget rows and overflow count include
only active work and unreadable runs.
`/agents <run-id>` still opens
saved completed runs, and an already-open watch stays open through completion.
An empty partial inventory says it is checking saved runs, not that no runs exist.
In fullscreen mode, click a named row to watch that child; click the header or
overflow count to open `/agents`. Picker rows and selection/Back/Close hints are
clickable too. Regular mode retains the keyboard path because Pi leaves mouse
input to the terminal there. Ctrl+O expands model/cwd details. The widget
clears once a complete error-free scan finds no active or unreadable runs, or when
the native parent is replaced; it stays while saved runs are still being checked. It is not
a footer-only count.
Use Up/Down to select, Enter to watch, and Escape to return/close (the displayed
hints follow Pi's configured selection keys). `/agents <exact-run-id>` opens that
run directly. Children and print/RPC modes do not install a watcher.

These views read this native owner's metadata and bounded published journal entries;
they never dispatch, continue, stop, send messages or trigger a model turn.
Published assistant text/tool calls may precede a running tool's result. Partial
journal records and unpublished provider token deltas are not presented as completed
entries. Agent tools remain the orchestration surface; this does not restore the
retired workflow UI or remote transcript APIs.

Long `delegate`, `agent_runs`, and `intercom` result cards start with a four-visual-line
preview, including output that wraps from one long logical line. Pi's native card
click and configured expand-tools key (Ctrl+O by default) reveal the full output.
Child completion and Intercom message cards use the same native expansion state;
their clickable header hints toggle the global tools-expanded view, just like
Ctrl+O. Full saved and model-visible content is unchanged.

## Installation and upgrade

```bash
pi install npm:@fitchmultz/pi-subagents
# Or register a built, runtime-only local checkout:
npm ci --omit=dev
pi install /absolute/path/to/pi-subagents
```

Development dependencies are for verification, not a second host runtime. Use the
committed npm lockfile. The build publishes a complete staged `dist/`; failed
compilation does not destroy the previous working tree. Do not rebuild a checkout
while active sessions load its files.

Finish in-flight work before migrating from the old workflow engine. Preserve the
prior package, native sessions, and durable state for rollback. Old profile files
are left untouched but no longer configure delegation. Chain/fanout orchestration,
acceptance loops, profile administration, canned output paths, custom workflow
UI, and durable supervisor-question revival are retired, not silently translated
into ordinary messaging. A regular `ask` timeout is not a persisted supervisor
approval workflow.

No package update implicitly grants deployment, publication, a global model/auth
change, or permission to restart a live bridge. Remote messaging requires the
separate authenticated bridge setup and coordinated companion migration.
