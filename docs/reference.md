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

Fresh context is the default. Fork uses the native conversation, including
historical tool calls and results; restricting a child's authority does not erase
the parent's evidence. Native Pi system/tool instructions and applicable project
resources still apply. Forking does not authorize nested delegation.

The default response acknowledges launch. It does not claim a model response or
completion. `async:false` waits for this new work. Cancelling that owned foreground
invocation requests stop; disposing the parent runtime detaches the observer
without implicitly stopping accepted background work.

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
Guidance that arrives after its run settles is reported as stale rather than
starting untracked work. Inspection text exposes the guidance command IDs and
admission states, native receipt publication and separately known process exit.
Pending admission is not consumption. Inspect the result and send a new continuation
if guidance became stale; do not infer acceptance from the old completed output.

A completed child can remain alive and messageable while its main remains
attached. Once the main detaches or is proven absent, idle actors exit and active
accepted work can finish before exit. Reload/resume uses saved state. There is no
arbitrary idle lease that silently expires a child while the main is still live.

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

## Read-only human observation

Interactive main sessions expose an agent status line and `/agents` list/watch.
Use Up/Down to select, Enter to watch, and Escape to return/close (the displayed
hints follow Pi's configured selection keys). `/agents <exact-run-id>` opens that
run directly. Children and print/RPC modes do not install a watcher.

These views read this native owner's metadata and bounded published journal entries;
they never dispatch, continue, stop, send messages or trigger a model turn.
Published assistant text/tool calls may precede a running tool's result. Partial
journal records and unpublished provider token deltas are not presented as completed
entries. Agent tools remain the orchestration surface; this does not restore the
retired workflow UI or remote transcript APIs.

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
