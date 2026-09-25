# pi-subagents

`pi-subagents` lets Pi delegate work to focused child agents. Use it for code review, scouting, implementation, parallel audits, saved workflows, background jobs, and anything else that benefits from a second or third set of model eyes.

## Installation

`pi-subagents` works with official Pi **0.87.0**, including saved-child continuation in a different directory. No Pi fork is required. Optional native asynchronous results and immediate usage accounting require additional public host capabilities; see [host capabilities and result delivery](#host-capabilities-and-result-delivery). Known Intercom host limitations are listed in the [Intercom guide](docs/intercom.md#limitations).

New sessions inherit the child process's working directory. Saved sessions retain their file, identity, header, and history; a requested directory change uses Pi's native SDK cwd override before startup. Same-directory resumes, including symlink and trailing-slash spellings, need no override. Structured-output startup preserves active tools and enables its capture tool. Use an explicit tool policy for restricted child runs; Pi can restore default built-ins when resuming without one.

With [pi-change-working-dir](https://github.com/fitchmultz/pi-change-working-dir) **0.5.0 or later**, tool and slash-command delegation, agent discovery, and command completion use the selected execution directory. Relative `cwd` overrides resolve from that directory, captured once before asynchronous preparation. New forks initialize their own selection without changing the parent's history. An explicit continuation `cwd` replaces the child's selection once; omitted continuation cwd preserves saved launch settings and later child `change_dir` selections.

Without a directory extension, native Pi cwd behavior is unchanged. An installed older or failing directory extension produces a clear error before work starts; update it rather than silently launching in another directory. Every child validates its loaded directory owner before its first prompt, including fresh runs. Inspection, review, questions, stop, and ordinary saved-child continuation remain available even when the parent's selected directory is unavailable. Native session identity, project context, and browser-group identity keep their existing ownership.

Install from GitHub:

```bash
pi install git:github.com/fitchmultz/pi-subagents
```

This package is not published to npm and does not provide an `npx` installer. Use `pi update --extension git:github.com/fitchmultz/pi-subagents` to refresh only this package. Before updating an in-use Pi checkout or extension, checkpoint work and **fully quit every Pi session using that installation**. Run rebuilds and updates from a separate terminal, then start fresh Pi processes. `/reload` can refresh supported settings, skills, and prompts, but cannot reliably activate changed JavaScript. Resume the **same saved parent session**, for example with `pi --session /path/to/parent.jsonl`, to retain run ownership, questions, and pending intercom delivery. A new or forked parent does not adopt them.

To restart the bundled broker too, close every Pi session using the same agent directory and wait at least five seconds before reopening Pi.

To load a local checkout into Pi, build it as a runtime-only package:

```bash
npm install --omit=dev   # prepare builds dist/ and removes development dependencies
pi install /absolute/path/to/pi-subagents
```

Local path registration does not run npm for you. Run `npm install --omit=dev` before loading the checkout and again after source edits; the existing prepare lifecycle obtains build dependencies, builds `dist/`, and leaves only runtime dependencies. This also works after a normal development install. A bare `npm run build` is not the runtime rebuild recipe because TypeScript is removed afterward.

Use the normal development workflow below for editing and validation, then rerun `npm install --omit=dev` before loading that checkout into Pi. Leaving the development Pi packages present can load their UI instead of the running Pi's UI. The runtime-only recipe avoids that mismatch; it does not repair Pi's loader when development packages remain installed.

Supported platforms: **macOS and Linux**. Termux on Android is unverified; Windows is not supported.

Pi core packages remain optional wildcard peers. Development dependencies are pinned to the coherent official Pi 0.87.0 cohort for compilation and package checks.

## Local validation

`npm run check:compat` uses the selected host installed in this checkout, never a hidden Pi from PATH. It checks host SDK/manifest-bin identity, builds with TypeScript typechecking, and qualifies both compiled entries with a private Intercom broker through the native SDK and bundled RPC CLI. Official hosts exercise same/different-cwd resume, acceptance, structured output, native result routing/ownership and tool activation. No provider credentials or inference services are used.

Repository CI runs three parallel pull-request checks: Linux Node 24 with the pinned fork runs units, package/install smokes, and focused integration for delegation, Intercom delivery, checkpoint/replay, native async usage, and process cleanup; Linux Node 22.19 checks the locked official Pi graph with its portable native contracts and a clean production source install; macOS Node 24 checks a pruned fork installation, broker/checkpoint startup, and macOS process identity. Main pushes run only official and fork installation/startup checks. The complete integration suite remains available locally through `npm run test:integration` against the fork; it is not repeated across pull-request jobs.

The fork CI job supplies `PI_COMPAT_HOST=fork`, `PI_COMPAT_EXPECTED_VERSION`, `PI_COMPAT_EXPECTED_PACKAGE_DIR`, `PI_HOST_INDEX`, and `PI_HOST_CLI` to verify the selected SDK and CLI. The official job uses the locked Pi cohort installed by `npm ci` with `PI_COMPAT_HOST=official`. Fork CI requires native checkpoint, asynchronous tool, and immediate usage APIs instead of silently skipping them. The ordinary official lane does **not** certify the extended replay/working-session contract: full official 0.87.0 integration still exposes five unchanged queue visibility, prompt-preparation ownership/startup, and `newContext` failures. The fork CI target is [`fitchmultz/pi` at `870f4f667bb0135f2d9d935c087dc45b6e48ff74`](https://github.com/fitchmultz/pi/commit/870f4f667bb0135f2d9d935c087dc45b6e48ff74) (Pi 0.87.0). See [host capabilities](#host-capabilities-and-result-delivery) and [limitations](docs/intercom.md#limitations).

Use an empty HOME outside your real home ancestry and a short temporary directory. Child tests use local fixtures and their own broker/profile. Linux Node 22.19 checks the declared support floor; macOS Node 24 checks the other supported platform without claiming a full platform-by-host matrix.

The completion guard recognizes verified `modifiedFiles` receipts from pi-apply-edits v1's `apply_patch`, `replace_text`, and `write_files`, including partial publication errors. Previews and unchanged results do not count as mutations. To exercise the real editor through native SDK events, use an installed v1 editor checkout:

```bash
PI_EDITOR_RECEIPT_TEST_ROOT=/absolute/path/to/pi-apply-edits \
  node --test test/integration/native-editor-receipts.test.ts
```

`PI_EDITOR_RECEIPT_TEST_SDK` selects another installed host package root; `PI_EDITOR_RECEIPT_EVIDENCE_DIR` retains receipts and fixture files. Without an editor checkout, this optional integration test skips.

### SDK embeddings of runtime-only installations

Before loading a pruned package with `DefaultResourceLoader`, set `process.env.PI_PACKAGE_DIR = getPackageDir()` from the **selected SDK**. This is the existing host-location contract for native session APIs and detached runners. Alternatively the host must be discoverable through the extension's dependency graph or an actual Pi executable on PATH. CLI consumers resolve their own host normally.

Without any of those host-location sources, `src/shared/native-session.ts` cannot locate session APIs. With a pruned compiled package, Node 24/Jiti can turn that failed top-level initialization into a module-loader assertion rather than surfacing the intended missing-host error. This is an unresolved loader diagnostic defect in the unsupported/misconfigured embedding path, not a general CLI/package failure. Qualification does not disable native imports or suppress loader errors: the supported explicit-host SDK path and the real bundled CLI both load the full runtime-only package.

To diagnose the full suite against the locked published Pi dependencies:

```bash
npm ci
npm run ci
```

Some native queue and prompt-preparation regressions still expose the [known host limitations](docs/intercom.md#limitations) on official Pi 0.87.0. Retain those checks and report their failures; a focused passing check does not establish a full-suite pass.

That command runs TypeScript no-emit checking, package shape smoke checks, an isolated single-package install smoke, and the full unit/integration suite. The bundled agent tests cover the Fitch profile set directly, so validation does not require pi-fitch-kit. `npm test` is intentionally the fast unit-test shortcut (`npm run test:unit`), not the full completion gate.

For a credential-free Linux gate against committed `HEAD`, Docker and `PI_LINUX_PI_ARCHIVE` are required. Supply an absolute path to a `.tar.gz` containing one top-level `pi/`: a checkpoint-capable Pi fork source checkout, its Linux `node_modules` (including workspace dependencies), and all built `dist/` output. It must include `pi/packages/coding-agent/dist/index.js` and `pi/packages/coding-agent/dist/bundle/cli.js`.

Prepare that checkout in a clean Linux build environment matching the image's CPU architecture and Node version. Install locked dependencies and complete Pi's workspace build, including its generated model data, before archiving. Do not copy host `node_modules`, Pi user state, `auth.json`, secret `.env` files, or credential-bearing npm/Git configuration. From the Linux build environment:

```bash
tar -czf /absolute/path/native-pi-linux-node24.tar.gz -C /clean/linux-build pi
```

Run with a matching archive for each image:

```bash
PI_LINUX_PI_ARCHIVE=/absolute/path/native-pi-linux-node24.tar.gz \
  bash scripts/linux-smoke.sh
PI_LINUX_IMAGE=node:22.19.0-bookworm \
PI_LINUX_PI_ARCHIVE=/absolute/path/native-pi-linux-node22.tar.gz \
  bash scripts/linux-smoke.sh # Node support floor
```

The archive is mounted read-only and extracted to `/native-pi`. The unprivileged `node` user installs locked package dependencies in `/workspace`, points the private CLI link and all SDK overrides at the supplied build, and runs the full, unchanged `npm run ci` gate. No host home, source mount, credentials, or model calls are passed into it. The gate does not patch Pi/Jiti or skip native cases.

## Real Pi smoke

The default local gate includes real SDK reload/reopen and native child-session ownership checks with a controlled CLI and no model calls. Other execution tests stay mock-heavy and deterministic. When you need to verify the actual local file-path Pi package boundary, run the opt-in real smoke:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
node scripts/real-pi-smoke.mjs
```

Use direct `node` invocation with the intended `pi` first on `PATH`. npm scripts prepend `node_modules/.bin`.

It installs this checkout into an isolated temporary Pi home, runs `pi list`, and loads the bundled subagent and intercom extensions. It does not install pi-fitch-kit, publish to npm, or use GitHub Actions.

Live model-backed subagent paths are intentionally opt-in because they can use provider credentials and tokens:

```bash
PI_REAL_SMOKE_MODEL=openai/gpt-6-astra node scripts/real-pi-smoke.mjs --llm
```

That mode copies local `auth.json` and `models.json` into the isolated Pi agent dir, then asks a real Pi session to exercise intercom status plus subagent list, waiting execution, background launch, and background completion. Set `PI_REAL_SMOKE_AUTH_AGENT_DIR` if your auth files are not in `~/.pi/agent`.

For a broader live gate, add `--llm-full`:

```bash
PI_REAL_SMOKE_MODEL=openai/gpt-6-astra node scripts/real-pi-smoke.mjs --llm-full
```

That also verifies real parallel, chain, file output, and acceptance flows. It checks actual tool calls and native settlement, and audits saved parent/child model identities. The smoke stops its own processes before removing copied credentials or artifacts, including on timeout or handled cancellation. Use `--keep-temp` to preserve noncredential evidence.

## Local test watchdog

`npm test`, `npm run test:unit`, `npm run test:integration`, and `npm run test:all` run through `scripts/run-tests.mjs`, which applies a per-suite local watchdog so hung child-process or worktree tests fail with the command context instead of hanging forever. The default is 300000ms. Override it when debugging slow local runs:

```bash
PI_TEST_TIMEOUT_MS=600000 npm run test:integration
# or
node scripts/run-tests.mjs integration --timeout-ms 600000
```

## Try this first

The **Agents** area above the editor shows active tasks on separate colored rows, with a running count and distinct waiting and needs-action states. A quietly pulsing green dot marks running work without repeating “working”; yellow attention indicators stay steady. The six-second pulse uses the existing refresh cadence and your theme’s colors (native emphasis for palette/default colors). In regular mode, offscreen dots stay steady instead of repainting scrollback when expanded details or other widgets fill the screen; the pulse resumes when visible. Task names, meaningful states and unread/replied badges take priority over activity previews; activity detail remains in the conversation and selected picker preview. Queued work does not count as running. The whole area disappears when no agents are active, even with unread results or a saved pin; completed conversations remain available through **Option+Shift+M** (**Alt+Shift+M**) or **`/agents`**. One child opens directly, while several use a task picker. Your own children come first across working directories and worktrees. **Other connected sessions** keeps ordinary peer messaging available.

Each child’s provider-qualified model appears in the strip, picker and conversation status when space allows. **Selected** is the current attempt’s requested model, including a fallback; an unprefixed model comes from a native model entry saved during that attempt; **saved** is recorded configuration, not a claim about an active request. Full assignment details retain the model’s source. Finished runs keep their own saved choice even if a continuation later changes the shared session. Provider and model namespaces stay intact. For the full identity at any terminal size, choose **F2 → Full original assignment**; message/tool **Full details / diff** also shows the recorded message model. Missing model data is shown as unavailable, never filled from current profile defaults.

The shortcut also closes the open Agents view. Change `shortcut` in the existing [Intercom config](docs/intercom.md#config); the entrance hint follows that setting.

The framed picker uses the available terminal width and shows each agent's role and state beside its task. Type to filter by task, agent, or any part of the original assignment. When space allows, the selected assignment is previewed below the list. Open its conversation and choose **F2 → Full original assignment** to read it without shortening it.

Finished conversations open at the beginning of their readable saved report, not the structured submission payload. Existing native answers are not repeated. Messages and grouped tool activity use Pi's native presentation; tool output expands through Pi's configured expand-tools key or a fullscreen click. **Full details / diff** shows recorded diffs as readable lines before raw arguments, results and acceptance data; contextual replies carry the selected evidence. Viewing a saved edit shows its recorded diff, not a new comparison against today's file.

Inside an agent conversation, use the native multiline editor to message that child directly. **Tab** switches between writing and selecting history; **Page Up/Down** scroll without following new output. **F2** lists all actions, including contextual Reply, full tool details/diff, working-tree changes, Keep visible, Stop, and Continue. **Esc** closes the current menu or detail view; from the conversation it returns to the parent without interrupting either agent or changing the parent draft. Child drafts, unread position and one optional pin survive returning to the same saved parent.

In native fullscreen mode, clicking a task opens it; clicking the same task or the **Agents** entrance again closes the view. Displayed action hints are clickable too, including Back, Send, actions, read/write focus, reply, quoted context and latest activity. The connected-session list, message composer and topics view also support their displayed controls. Parent result cards, slash results and notifications expand on click and keep Pi's configured expansion shortcut. Labels use Pi's native **Option** wording on macOS and **Alt** elsewhere; shortcut configuration and key behavior do not change. Regular terminals use the keyboard.

| Agent-view shortcut | Action |
| --- | --- |
| Enter | Send to the named child, or answer its real waiting question |
| Alt+R | Reply with the selected message, tool result or change attached |
| Alt+D | Inspect full details while reading; native word deletion while composing |
| Alt+G / Alt+L | Working-tree diff / jump to latest activity |
| Alt+Q / Alt+P | Remove quoted context / pin or unpin this child |
| Alt+S / Alt+C | Stop only this child / explicitly continue with the draft |

Queued children say **waiting to start**. Their drafts stay available until they run; messaging or Continue never launches a duplicate queued child. Viewing finished work never launches it. If a child finishes while you compose or send, the draft remains available for **Continue**. An older multi-child runner that cannot target one child is reported as unavailable rather than stopping its siblings. A saved conversation or launch profile that is missing is likewise not invented. Native selection/copy covers visible fullscreen text; cross-page drag selection is not provided.

Human messages are marked as user direction in the child's own conversation. Broker acceptance means **waiting**, not read or acted upon; a native receipt confirms delivery to the conversation, and an actual subsequent response is separate. The parent receives one small informational breadcrumb with the direction, not an approval or relay request. Working-tree diffs are explicitly workspace-wide, not attributed to one child when agents share a directory.

For ordinary work from the model, use the compact tools; the full workflow schema stays unloaded:

```typescript
agent_runs({ action: "profiles" })
delegate({ agent: "worker", task: "Implement the approved fix", worktree: true })
agent_runs({ action: "list" })
agent_runs({ action: "inspect", id: "<run-id>" })
agent_runs({ action: "inspect", id: "<run-id>", full: true }) // Full task and launch configuration
agent_runs({ action: "nudge", id: "<run-id>", message: "Keep the public API unchanged." })
agent_runs({ action: "continue", id: "<run-id>", message: "Now check the edge case." })
agent_runs({ action: "review", id: "<run-id>", decision: "accepted", message: "Checked the result." })
```

`delegate` uses the same durable run owner and acceptance path as `subagent`; `worktree: true` runs one isolated writer through the existing worktree path. `agent_runs` keeps the saved parent's work discoverable across working directories, reloads, and restarts. A nudge never restarts completed work; `continue` explicitly revives its saved session. Use `load_subagent` for parallel groups, chains, detailed overrides, and profile administration. Existing `subagent` calls remain supported.

### Owned runs, review, and continuation

`continue` and `answer` accept `async: false` to wait for the actual new or redirected run's saved result. Cancelling a newly launched `async: false` continuation requests cancellation of that new run, not an older sibling. On the portable path, important steered Intercom messages release the wait so the parent can respond while the child keeps working. Continue useful work or end the turn; the saved completion is delivered separately. A native asynchronous call stays pending through Intercom attention and blocking child questions; its result belongs to the original call. Explicit queue/passive messages do not release waits.

Stop receipts mean **requested**, not process exit. Saved results separately record the actual agent-process exit code/signal when observed. A returned tool result is not proof that every command descendant exited, and an unrecorded command result means **exit unconfirmed**, not “still running” or exit zero.

If a background runner exits while its children remain alive, Stop signals those recorded child process groups directly after checking their saved process identities. Selected-child Stop still leaves siblings running. Older runs without saved process identities report that ownership cannot be verified.

`agent_runs({ action: "list" })` puts unanswered questions first, then failures, interrupted or unconfirmed work, live work, completed-but-unreviewed results, and other runs. It returns 20 runs by default. Use `offset` and `limit` (1–100) to page; `details.runList.nextOffset` points to the next page. Paging never discards history or disables exact-ID lookup. Ambiguous run-ID prefixes report the total match count and at most five candidates; retry with a longer prefix or full run ID. After the first read, unchanged finished runs reuse compact ordering facts instead of reloading every result and launch contract. Live or unconfirmed work, questions, and the displayed page stay fresh. `inspect` shows a concise task/result summary, acceptance outcome, questions, errors, paths, review, continuation links, and available live diagnostics. Use `full: true` for the full task and saved launch configuration (also supported by exact `subagent` status). Stored details and history are unchanged. Explicit continuation links identify separate work; a successor's result or review never satisfies the predecessor automatically. Final continuation results name the current run ID and its predecessor, including results recovered through a native pending call.

`review` records `decision: "accepted"` or `"needs_changes"`, with an optional `message`. Review a finished result, not a live run. The decision is separate from execution status, runtime acceptance checks, and delivery. It returns a short saved-decision receipt, not another inspection. The review note is parent-only and is **not sent to the child**, including on revival. Put actionable instructions in `continue` or `nudge`. Review does not run checks, launch another child, or mark a follow-up accepted; inspect and late nudges do not restart anything.

Children also receive `PI_SUBAGENT_ROOT_SESSION_ID`: the owning root's actual Pi session ID, inherited unchanged through fresh/forked children, nested delegation, and detached runner configuration. Saved children inherit the reviving parent's root. This is independent of cwd, transcript file paths, run IDs, and ordinary Pi fork/clone ancestry. Extensions such as pi-agent-browser-native use it to share one browser within the parent/descendant group while keeping unrelated roots independent. The parent process environment is not changed; opening a child transcript as an unrelated standalone root does not adopt that group.

Continuation and exited-question revival reuse the resolved provider/model, thinking level, profile, selected skill injection, tool/extension and context policies, output settings, limits, and acceptance contract. Changed profile defaults are not substituted. `agent_runs` accepts explicit `model`, `cwd`, `output`, and `acceptance` overrides on `continue`/`answer`; `agent` explicitly selects a current profile. Detailed overrides remain available through `subagent({ action: "resume", ... })`. Launch overrides apply when starting a continuation, not when delivering a follow-up or answer to a still-live child. In particular, live `continue`/`answer` acceptance overrides do **not** amend that child's acceptance contract. A missing worktree can be replaced with an explicit `cwd`; a missing child session cannot be invented. New acceptance sessions inherit their launch cwd; saved-session launches, including acceptance finalization, use the header cwd directly when it resolves to the same existing directory as the requested cwd. A different effective cwd is supplied to native `SessionManager.open` by a launch-scoped Node preload before Pi creates tools, project resources, or extensions, without rewriting the saved session header, identity, or history. If the same saved child already has a live continuation, another `continue` sends it the follow-up instead of starting a second process. Status labels distinguish **Launch cwd** from intercom's **Native session cwd**; neither proves a shell command's physical directory. The **Saved session header cwd** remains unchanged by the native override.

When the saved launch records that an output path was generated from a relative profile default, continuation and exited-question revival generate a new path for the successor using that saved filename, leaving the predecessor file untouched. Selecting a current profile with `agent` preserves the saved filename independently of that profile's current default; an explicit `output` override changes the output choice. Explicit paths, absolute profile defaults, and `output: false` retain their saved choices unless overridden. Older snapshots without output-origin information keep their saved paths; supply an explicit `output` override to choose a different path.

Old receipts recover their handles and available results from saved parent/child sessions and existing metadata. Active legacy owners finish with their original runtime and files; they are not relaunched or converted in place. Keep that installation available until its runs and question waiters finish. Terminal legacy results can be preserved in durable storage without deleting their original history. When an old run has no saved profile snapshot, continuation asks for an explicit `agent` choice rather than guessing its original configuration. Resuming the same saved parent restores its ownership; a new or forked parent does not automatically adopt that work. Explicit legacy async-ID inspection remains available without adopting the inspected run.

You do not need to create agents, write config, or learn slash commands. After installing, ask Pi for delegation in plain language:

```text
Use reviewer to review this diff.
```

```text
Ask oracle for a second opinion on my current plan.
```

```text
Use scout to understand this code based on our discussion then ask me clarification questions.
```

```text
Run parallel reviewers: one for correctness, one for tests, and one for unnecessary complexity.
```

That is enough to start.

## What happens

Pi is the parent session. A subagent is a focused child Pi session with its own job.

For ordinary delegation, Pi uses `delegate` and `agent_runs`. Parallel workflows and advanced controls use `load_subagent` to load the full orchestration schema on demand.

Every new run has one detached owner, whether it is a single task, parallel group, chain, saved workflow, or continuation. That owner starts each Pi attempt through Pi's native JSON CLI, preserving native startup, project trust, resources, and sessions. Claude Code uses its own CLI adapter through the same child-attempt lifecycle. `async: false` and `--fg` wait on that owner's saved result and stream progress; they do not select a different executor.

Background delivery is the default. A waiting call and a background call use the same controls, acceptance checks, saved results, and recovery path.

Installing the extension does not start an automatic reviewer in the background. It gives Pi a delegation tool. `acceptance.review` is not a supported shortcut: review remains parent-controlled so a worker cannot spend a full run and then fail for a reviewer result the runtime never produced. If you want every implementation reviewed, say that in your prompt or put it in your project instructions:

```text
When you finish implementing, run a reviewer subagent before summarizing.
```

## Host capabilities and result delivery

**Portable Pi:** ordinary background calls return a launch receipt. The detached owner keeps working, saves its result, and notifies the same saved parent. Use `async: false` or `--fg` when the calling tool must wait for the result, including one-shot callers that need it on stdout. These waits are abort-aware. Official Pi 0.87.0 supports this path, but its [idle-message and prompt-preparation limitations](docs/intercom.md#limitations) still apply to automatic wakeups.

**Native asynchronous tools:** an enhanced host must expose `Tool.async`, `Tool.resume`, and `ctx.getPendingToolCalls()`, and the selected model must advertise `supportsAsyncTools`. The extension enables this path only when the actual invocation appears in the host's pending calls. `async: true` alone is not evidence of native support.

For an admitted native call, the parent journals the original tool-call ID and immutable run identity before launching or delivering work. The host can continue other work while the call is pending. Completion returns to that original call, without a second ordinary completion notice. Resuming the same parent after restart, compaction, or branch navigation reconnects to the saved work when that call is selected; it does not launch it again. A forked parent cannot adopt the original parent's calls. A call that already returned an ordinary receipt never becomes a pending native call retroactively.

Native immediate parent accounting separately requires the public idempotent `recordUsage` API. Without it, usage is carried by finalized tool-result receipts; see [usage accounting](#usage-accounting). Neither official Pi 0.87.0 nor the existing `afed789` fork baseline establishes support for these newer APIs.

**Qualified enhanced host:** [`fitchmultz/pi` at `8fb7886130ff1fedc415bdd6fea03aef8a8957d8`](https://github.com/fitchmultz/pi/commit/8fb7886130ff1fedc415bdd6fea03aef8a8957d8) (Pi 0.87.0), tested on macOS arm64 with Node 24.21.0 and Linux arm64 with Node 22.19.0 and 24.21.0. Native tests cover original-call recovery across restart, compaction and branch navigation, fork ownership, accepted steering and disconnect recovery, and once-only accounting, including usage saved before the first parent assistant turn.

To require these APIs during enhanced-host qualification, set `PI_NATIVE_ASYNC_REQUIRE_HOST=1` and `PI_PARENT_USAGE_REQUIRE_NATIVE=1` alongside `PI_COMPAT_HOST=fork` when running `npm run check:compat` against that installed host graph. Missing capabilities then fail instead of skipping their tests.

## Good first prompts

These cover most day-to-day use:

```text
Ask oracle for a second opinion on my current plan. Challenge assumptions and tell me what I might be missing.
```

```text
Use oracle to help solve this hard bug. Have it inspect the code and propose the best next move before we edit anything.
```

```text
Run parallel reviewers on this diff. I want one focused on correctness, one on tests, and one on unnecessary complexity.
```

```text
Have worker implement this approved plan. Afterward, run parallel reviewers, summarize their feedback, and apply the fixes that make sense.
```

```text
Run a review loop on this change until reviewers stop finding fixes worth doing, with a max of 3 rounds.
```

```text
Use scout to understand the auth flow, then have planner turn that into an implementation plan.
```

Those are ordinary Pi requests. Pi decides whether to call `subagent`, which agent to use, and whether a chain or parallel run makes sense.

## Common workflows

| Want | Ask naturally |
|------|---------------|
| Get a second opinion | “Ask oracle to review this plan and challenge assumptions.” |
| Solve a hard problem | “Use oracle to investigate this bug before we edit.” |
| Review a diff | “Use reviewer to review this diff.” |
| Run parallel reviewers | “Run reviewers for correctness, tests, and cleanup.” |
| Implement then review | “Implement this, then review it.” |
| Review until clean | “Run a review loop on this change with a max of 3 rounds.” |
| Execute a plan carefully | “Have worker implement this approved plan, then run reviewers and apply the feedback.” |
| Scout before planning | “Use scout to inspect the auth flow before planning.” |
| Run in the background | “Run this in the background.” |
| Watch a changing process | “Run watcher in the background to monitor PR checks; notify me on material changes and stop when they finish.” |
| Browse agents | “Show me the available subagents.” |
| Use a saved workflow | “Run the review chain on this branch.” |
| See running work | “Show active async runs.” |
| Check setup | “Check whether subagents are configured correctly.” |

The extension ships with builtin agents you can use immediately.

## Builtin agents in plain English

| Agent | Use it when you want... |
|-------|--------------------------|
| `scout` | Fast codebase recon and a compressed handoff. |
| `context-builder` | Requirements and codebase analysis that produces implementation-ready context. |
| `researcher` | Evidence-driven research for consequential technical decisions. |
| `watcher` | Read-only background monitoring with timely material-change updates to the parent. |
| `planner` | A concrete implementation plan without edits. |
| `worker` | End-to-end implementation of an approved, bounded task. |
| `debugger` | Root-cause diagnosis with reproduction and repair evidence. |
| `fixer` | A bounded set of already-decided fixes without replanning. |
| `reviewer` | General implementation review against the task and evidence. |
| `reviewer-gpt` | Evidence-backed maintainability and correctness review. |
| `reviewer-claude` | An independent cross-model review of assumptions and product risk. |
| `reviewer-security` | Security and data-safety review for trust-boundary changes. |
| `reviewer-ponytail` | An over-engineering and slop review that never trades away intended behavior. |
| `ui-designer` | Rendered UI, layout, accessibility, and visual polish. |
| `writer` | Human-facing documentation, announcements, and polished copy. |
| `oracle` | A forked second opinion that protects the current decision contract. |
| `delegate` | Lightweight generic delegation that stays close to the parent session. |

Use the narrowest role that fits the task. Keep implementation to one writer and launch reviewers separately. Every bundled profile sets `allowSubagents: false` and `maxSubagentDepth: 0`, so these defaults keep delegation in the parent. Custom profiles can enable useful helpers within their assigned task, subject to the [depth limit](#recursion-guard); the original parent still owns integration and final delivery.

## Changing a builtin agent's model

The bundled Fitch role profiles pin explicit primary and fallback routes. `delegate` inherits the current Pi model.

| Primary route | Agents |
|---------------|--------|
| `openai-codex/gpt-6-astra` | `context-builder`, `oracle`, `planner`, `researcher`, `worker` |
| `openai/gpt-6-astra` | `debugger`, `fixer`, `reviewer`, `reviewer-gpt`, `reviewer-ponytail`, `ui-designer` |
| `anthropic/claude-fable-5-1` | `reviewer-claude` |
| `cloudflare-ai-gateway/claude-fable-5-1` | `writer` |
| `xai/grok-4.6` | `reviewer-security` |
| `cloudflare-ai-gateway/gpt-5.6-sol` | `scout`, `watcher` |
| Current Pi model | `delegate` |

Each role keeps its own ordered fallback list and thinking level. Models must be present in Pi's catalog and available to the selected provider account; API-key access through `openai` does not imply ChatGPT access through `openai-codex`. Refresh the catalog with `pi update --models` or add custom entries in `~/.pi/agent/models.json`. Override a role when its routes are unavailable; you do not need to copy the bundled agent file.

For one run, put the override in the command:

```text
/run reviewer[model=anthropic/claude-sonnet-4:high] "Review this diff"
```

For a persistent override, edit settings. This example pins the reviewer everywhere, adds a backup model for provider failures, and leaves the other builtins on their configured routes:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

Use `~/.pi/agent/settings.json` for a user override or `.pi/settings.json` for a project override. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable a builtin. If you want a totally different agent, create a user or project agent with the same name; for normal tweaks, prefer overrides.

## Where running subagents show up

Waiting runs stream progress in the conversation. Set `async: false`, use `--fg`, enable `clarify: true`, or provide `timeoutMs`/`maxRuntimeMs` to request this view. A timeout sets the owner's wall-clock budget for the run; it is not just a limit on how long the parent watches. While the run is active, `subagent({ action: "extend", id: "...", extendMs: 300000 })` requests more time. When the timeout expires, running children are soft-interrupted, completed children stay in the result, and timed-out children return `timedOut: true` with a stable timeout message, partial output, and resume guidance when a child session was persisted. Waiting reviewer runs raise short timeout budgets to at least 15 minutes. Planner/researcher-style roles raise short budgets only when local run history shows they need longer.

Background runs are the default and keep working independently of the parent's view. Continue useful parent work while they run; if none remains, end the turn for completion delivery instead of polling. Delivery follows the [host's capabilities](#host-capabilities-and-result-delivery). Use `subagent({ action: "status" })` for diagnostics, or inspect a specific run with `subagent({ action: "status", id: "..." })`.

An incomplete active Pi goal does not require foreground execution. If child evidence gates the next step, end the current turn and continue the goal after automatic completion delivery; do not advance past the missing evidence.

All children share the task-labelled Agents strip. A waiting tool returns the saved result; a native pending call receives its own completion; other background runs send completion notifications. Parallel groups show per-agent progress. Chains with parallel groups keep their grouped shape in progress and results, so failed or paused agents stay visible next to completed ones. Nested delegation remains disabled in bundled profiles.

You can also ask naturally:

```text
Show me the current async runs.
```

If something feels misconfigured, run:

```text
/subagents-doctor
```

or ask:

```text
Check whether subagents and intercom are set up correctly.
```

Doctor checks the loaded intercom bridge and the current broker registration without requesting a reconnect. Connected, disconnected, connecting, and unknown states are distinct; a missing bridge response is not reported as a healthy connection.

The report identifies the running Node process, Pi's loaded version and reported resource directory, and the loaded extension build. Its SHA-256 fingerprint is embedded at build time from the emitted JavaScript, excluding the stamp itself; replacing files on disk does not change that loaded identity. Direct source loads report an unknown build.

## Recommended orchestration pattern (scaffolding)

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → planner → worker → fresh reviewers → worker
```

Example prompt files for these patterns remain in `prompts/` for reference.

Packaged `oracle` defaults to forked context; the other Fitch role profiles default to fresh context. Forked context is rejected when an affected agent's effective primary or fallback model uses the `anthropic/` provider, and explicit context/model overrides cannot bypass that restriction.

Child boundaries are enforced at runtime. Spawned children do not receive the parent-only `pi-subagents` skill. Their model context omits parent-only orchestration, slash-result, notification, and control messages without deleting saved history. Leaf children also omit orchestration tool calls/results. Delegation-enabled children retain that tool history so their own helper calls remain usable on later turns and resumes.

Children do not receive delegation tools by default. When a profile enables delegation and the depth limit allows it, the child starts with `delegate`, `agent_runs`, and `load_subagent`. Advanced workflows and controls remain available through `load_subagent`; nested execution still waits by default. The child may use helpful agents within its assigned scope without repeating approval requests for already-authorized work. It remains responsible for its assigned result; the original parent owns integration, review synthesis, and final delivery.

## Example prompts

The files in `prompts/` document common workflows without registering additional slash commands:

| File | Use it for |
|------|------------|
| `parallel-review.md` | Launch fresh-context reviewers with distinct angles, then synthesize what to fix. |
| `review-loop.md` | Run parent-controlled worker, reviewer, and fix-worker cycles until clean or capped. |
| `parallel-research.md` | Combine `researcher` and `scout` for external evidence, local code context, and practical tradeoffs. |
| `parallel-context-build.md` | Run `context-builder` agents in parallel to produce planning handoff context and meta-prompts. |
| `parallel-handoff-plan.md` | Combine external research and `context-builder` passes into an implementation handoff plan and meta-prompt. |
| `gather-context-and-clarify.md` | Scout/research first, then ask the user the clarification questions that matter. |
| `parallel-cleanup.md` | Run review-only cleanup passes after implementation. |

## Bundled intercom

The same `pi-subagents` install registers the intercom extension and skill. Managed children get a private coordination channel back to the parent Pi session unless an explicit agent extension allowlist excludes it. See [the intercom guide](docs/intercom.md) for direct peer messaging, keyboard UI, tool actions, configuration, and broker details.

If you previously installed the standalone package, remove that old settings entry once to avoid loading two intercom extensions:

```bash
pi remove git:github.com/fitchmultz/pi-intercom
pi install git:github.com/fitchmultz/pi-subagents
```

Most users do not call `intercom` directly. `pi-subagents` injects fixed default bridge instructions and auto-adds `intercom`, `contact_supervisor`, and any required `structured_output` tool when a child has an explicit tool list. If an agent sets an explicit `extensions` allowlist, include `pi-intercom` there or those child tools stay sandboxed out. The bridge resolves that entry, including old standalone paths, to the bundled extension.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation in the background. If the worker gets blocked or needs a product decision, have it ask me through intercom.
```

```text
Ask oracle to review this plan. If it sees a decision I need to make, have it ask me instead of assuming.
```

The child can use one dedicated coordination tool:

- `contact_supervisor`: the child contacts the parent/supervisor session that delegated the task. Use `reason: "need_decision"` only when the ephemeral child cannot safely continue and must remain alive for one steered supervisor reply. Use `reason: "interview_request"` only when it cannot safely continue until it receives multiple structured answers. Use `reason: "progress_update"` only for discoveries or changes the parent needs while working. These steer at the next tool boundary; skip starts, redundant status, and routine completion, and retain material findings in the final result. Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

Children return routine completion through their normal result. For portable background delivery, the parent sends one grouped completion through `pi-intercom` per finished run, including child targets, summaries, nested-child summaries, and saved evidence paths. A waiting tool or native pending call receives the saved result directly; the watcher suppresses a duplicate completion notice. Intercom remains available for live questions and guidance while work continues.

### Questions that survive a reload

Blocking supervisor questions are saved before notification, with their owner session, child session, and launch-time acceptance/output requirements. They do not expire at the ordinary intercom ask timeout. A portable waiting call returns so the supervisor can answer while the same owner and child remain available. A native asynchronous call stays pending. Neither state is successful completion.

```typescript
agent_runs({ action: "questions" })
agent_runs({ action: "answer", id: "<run-id>", questionId: "<question-id>", message: "Use the stable API." })
agent_runs({ action: "stop", id: "<run-id>" })
```

Resume the **same saved supervisor session**, even from another cwd, to recover its questions. A different session does not silently adopt them. Ordinary `intercom` replies also save the answer while the live waiter is connected. After supervisor/broker restart, prefer `agent_runs` questions/answer; a nudge is guidance, not an answer to a blocking question.

Answers are saved once. Repeating the same answer does not start duplicate work; conflicting answers are rejected without replacing the original. A live child reads the saved answer; an exited child resumes from its saved session in a new run, retaining the original acceptance contract. An answer receipt is not execution completion. `stop` cancels outstanding questions and aborts a live waiter using its saved run identity, including after a parent restart.

If an answer launch was interrupted before a continuation existed, the reply gives an explicit `continue` recovery call. It refuses to restart when launch evidence is uncertain; inspect the advertised continuation first. Questions, answers, launch contracts, and results live under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/subagent-runs/<run-id>/`, separate from temporary logs. Ownership and review use native parent `subagent-run` entries; pending intercom delivery is journaled in that same saved Pi session. Temporary cleanup does not erase these records, but deleting saved sessions or metadata removes their recovery data. Pending questions are not age-cleaned.

After 10 minutes of no observed child activity by default, needs-attention notices offer `agent_runs` inspection, stopping, or nudging. A matching unresolved durable question says **Waiting for supervisor input** and gives its question ID and answer call; a saved but undelivered answer remains actionable. An active tool is named with its elapsed time and no-output age, with guidance to inspect command progress—not a claim of a hang or forward progress. When the child is registered, prefer `agent_runs({ action: "nudge", id: "<run-id>", message: "What are you blocked on?" })` for live guidance, answers, corrections, or blockers. It sends a non-blocking steer that supplements the child's active task unless the message explicitly replaces it. Use the status-shown blocking intercom ask only when the parent must remain alive waiting for a reply.

If messages do not show up, run:

```text
/subagents-doctor
```

There is no bridge mode, instruction-file config, or second package to install.

At this point, you know enough to use the plugin. The rest of this README is reference material for exact command syntax, custom agents, saved chains, worktrees, and configuration.

## Direct commands

Skip this section until you want exact syntax.

| Command | Description |
|---------|-------------|
| `/run <agent> [task]` | Run one agent; omit the task for self-contained agents |
| `/chain agent1 "task1" -> agent2 "task2"` | Run agents in sequence |
| `/parallel agent1 "task1" -> agent2 "task2"` | Run agents in parallel |
| `/run-chain <chainName> -- <task>` | Launch a saved `.chain.md` or `.chain.json` workflow |
| `/subagents-doctor` | Show read-only setup diagnostics |

Commands validate agent names locally, support tab completion, and send results back into the conversation.

### Per-step tasks

Use `->` to separate steps and give each step its own task:

```text
/chain scout "scan the codebase" -> planner "create an implementation plan"
/parallel scout "map security-sensitive code" -> researcher "check current security guidance"
```

Both double and single quotes work. You can also use `--` as a delimiter:

```text
/chain scout -- scan code -> planner -- analyze auth
```

Steps without a task inherit behavior from the execution mode. Chain steps get `{previous}`, the prior step’s output. Parallel steps use the first available task as a fallback.

```text
/chain scout "analyze auth" -> planner -> worker
# scout gets "analyze auth"; planner gets scout output; worker gets planner output
```

For a shared task, list agents and place one `--` before the task:

```text
/chain scout planner -- analyze the auth system
/parallel scout researcher -- investigate security requirements
```

### Inline per-step config

Append `[key=value,...]` to an agent name to override defaults for that step:

```text
/chain scout[output=context.md] "scan code" -> planner[reads=context.md] "analyze auth"
/run scout[model=anthropic/claude-sonnet-4] summarize this codebase
/parallel scout[skills=security] "map backend risk" -> researcher[model=openai/gpt-5-mini] "research frontend guidance"
```

| Key | Example | Description |
|-----|---------|-------------|
| `output` | `output=context.md` | Write results to a file. For `/chain` and `/parallel`, relative paths live under the chain directory; for `/run`, relative paths resolve against cwd. |
| `outputMode` | `outputMode=file-only` | Return only a concise file reference for saved output instead of the full saved content. Requires `output`; default is `inline`. |
| `reads` | `reads=a.md+b.md` | Read files before executing. `+` separates multiple paths. |
| `model` | `model=anthropic/claude-sonnet-4` | Override model for this step. |
| `skills` | `skills=planning+review` | Override injected skills. `+` separates multiple skills. |
| `progress` | `progress` | Enable progress tracking. |

Set `output=false`, `reads=false`, or `skills=false` to disable that behavior explicitly. Do not use `output=false` for file-only returns; use `outputMode=file-only` with an `output` path.

### Execution mode and forked runs

Slash commands launch the same detached owner by default. Add `--fg` when the command must wait for its result. `--bg` explicitly requests background delivery, which is useful when configuration sets `asyncByDefault` to `false`. `forceTopLevelAsync` overrides `--fg`, so disable it before requesting a wait:

```text
/run scout "audit the codebase"
/chain scout "analyze auth" -> planner "design refactor" -> worker
# One /parallel call returns one aggregate completion; use separate calls for per-child wakeups.
/parallel scout "scan frontend" -> scout "scan backend"
/run reviewer "review this diff" --fg
```

Add `--fork` to start each child from a real branched session created from the parent’s current leaf:

```text
/run oracle "review this decision" --fork
/chain scout "analyze this branch" -> oracle "plan next steps" --fork
/parallel scout "audit frontend" -> oracle "review backend constraints" --fork
```

You can combine either execution override with `--fork`:

```text
/run oracle "review this decision" --fork --fg
/run oracle "review this decision" --fork --bg
```

Prefer separate single-agent runs for independent fanout when each result should reach the parent without waiting for every sibling. Use a parallel group when the parent needs one aggregate result or shared concurrency/worktree controls. Continue useful parent work or end the turn for delivery; do not run sleep or status-polling loops. This also applies when child evidence gates an incomplete active goal. Non-interactive one-shot Pi callers should set `async: false` when stdout must contain the child result. On the portable path, omitted `async` returns a launch receipt.

The `oracle` and `worker` builtins are designed for an explicit decision loop. A typical pattern is to ask `oracle` for diagnosis and a recommended execution prompt, then only run `worker` after the main agent approves that direction.

## Clarify and launch UI

Tool calls launch directly by default. Single, parallel, and chain runs can opt into the clarify UI with `clarify: true` when you want to preview or edit the workflow before it runs; slash commands launch directly.

Common clarify keys:

- `Enter` launches and waits, or returns a background receipt if background is toggled on
- `Esc` cancels or backs out
- `↑↓` moves between steps or tasks
- `e` edits the task/template
- `m` selects a model
- `t` selects thinking level
- `s` selects skills
- `b` toggles background execution
- `w` edits output/write behavior where supported
- `r` edits reads where supported
- `p` toggles progress tracking where supported
Picker screens use `↑↓`, `Enter`, `Esc`, and type-to-filter. The full-screen editor supports word wrapping, paste, `Esc` to save, and `Ctrl+C` to discard.

## Agents and chains

Agents are markdown files with YAML frontmatter and a system prompt body. They define the specialist that will run in the child Pi process.

Agent locations, lowest to highest priority:

| Scope | Path |
|-------|------|
| Builtin | Installed package's `agents/` directory |
| User | `~/.pi/agent/agents/**/*.md` |
| Project | `.pi/agents/**/*.md` |

Project discovery also reads legacy `.agents/**/*.md` files. Nested subdirectories are discovered recursively. `.chain.md` files do not define agents. If both `.agents/` and `.pi/agents/` define the same parsed runtime agent name, `.pi/agents/` wins. Use `agentScope: "user" | "project" | "both"` to control discovery; `both` is the default and project definitions win runtime-name collisions.

Builtin agents load at the lowest priority, so a user or project agent with the same name overrides them. The Fitch role profiles pin provider models, fallback routes, and thinking levels. `delegate` inherits the current Pi model. `oracle` is the only packaged fork-default role. The other Fitch profiles default to fresh context and use Pi's normal tool surface.

### Builtin overrides

You can override selected builtin fields without copying the whole agent. Overrides live in settings:

- User: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Example:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "inheritProjectContext": false
      }
    }
  }
}
```

Supported override fields are `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `disabled`, `skills`, `tools`, and `systemPrompt`. Use `defaultContext: false` in builtin overrides to clear an inherited context default. Project overrides beat user overrides.

Set `disabled: true` to hide a builtin from runtime discovery and agent-facing `subagent({ action: "list" })` output. For bulk control, set `subagents.disableBuiltins: true` in settings.

### Prompt assembly

Subagents start with fresh conversation context while preserving Pi's operating environment by default: the base prompt, project instruction files, and discovered skills catalog. Give a fresh child the task and source paths it needs; it does not receive the parent's conversation unless you choose `fork`.

Role boundaries, structured-output instructions, and Intercom guidance use Pi's native prompt sections. If another extension supplies an exact full-prompt override, the required sections are appended to that override. This preserves the instructions but changes the prompt prefix; neither that fallback nor filtered fork context guarantees cache-prefix reuse.

Use these fields only when an agent needs stricter isolation or inherited conversation:

| Field | Effect |
|-------|--------|
| `systemPromptMode: replace` | Replace Pi's normal base prompt with the agent prompt. |
| `inheritProjectContext: false` | Suppress current project-instruction loading from files like `AGENTS.md` and `CLAUDE.md`; inherited fork history is not scrubbed. |
| `inheritSkills: false` | Disable discovered skills; explicitly selected skills and inherited fork history remain separate. |
| `defaultContext: fork` | Use forked session context when a launch omits `context`; explicit `context: "fresh"` still wins. |

Bundled agents use the same prompt, project-context, and skill inheritance defaults. `oracle` alone opts into forked conversation context; the other profiles remain fresh.

For `claude-code/*` models, append mode preserves Claude Code's native base prompt and its native `CLAUDE.md` and `.claude/skills` discovery. `inheritSkills: false` passes `--disable-slash-commands`, which disables Claude Code skills and commands. Setting both inheritance flags to `false` also disables Claude Code setting sources; Claude Code rejects `inheritProjectContext: false` with `inheritSkills: true` because its setting sources bundle project instructions and skills. Claude Code children never support nested delegation, regardless of depth settings.

This changes the behavior of custom agents that omitted these fields before v0.38.0. To preserve the old isolated policy, set `systemPromptMode: replace`, `inheritProjectContext: false`, and `inheritSkills: false` explicitly. Profiles that intentionally delegate must now also set `maxSubagentDepth: 2` or higher, with an installation limit at least as high.

Pi task arguments stay inline through 900 UTF-8 bytes, including the `Task: ` prefix; larger tasks use Pi's native `@file` input. System instructions use a separate temporary file, including for agents named `task`. The shared Pi child-attempt driver uses this transport for every execution mode; Claude Code receives its task as positional input.

### Agent frontmatter

A typical agent looks like this:

```yaml
---
name: scout
# Optional: registers this as code-analysis.scout while preserving name: scout
package: code-analysis
description: Fast codebase recon
tools: read, grep, find, ls, bash, mcp:chrome-devtools
extensions:
model: claude-haiku-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
thinking: high
systemPromptMode: append
inheritProjectContext: true
inheritSkills: true
skills: safe-bash, chrome-devtools
allowSubagents: false
output: context.md
defaultReads: context.md
defaultProgress: true
completionGuard: false
interactive: true
maxSubagentDepth: 0
maxExecutionTimeMs: 600000
maxTokens: 50000
---

Your system prompt goes here.
```

Important fields:

| Field | Notes |
|-------|-------|
| `package` | Optional package identifier. A file with `name: scout` and `package: code-analysis` registers as `code-analysis.scout`; serialization keeps `name` and `package` separate. |
| `tools` | Tool allowlist, including extension tools. `mcp:` entries select direct MCP tools when `pi-mcp-adapter` is installed. Omit it to keep Pi's normal configured tool surface. |
| `allowSubagents` | Opt-in child-safe nested delegation. Disabled in bundled profiles and still bounded by `maxSubagentDepth`. |
| `extensions` | Omitted means normal extensions; empty means no extensions; comma-separated values allowlist specific extensions. |
| `model` | Default model. Bare ids prefer the current provider when possible, then unique registry matches. |
| `fallbackModels` | Ordered backup models for provider/model failures such as quota, usage limit, auth, timeout, or unavailable model. The shared driver first retries the same model once for recoverable transport failures such as WebSocket/stream/socket timeouts or SIGTERM-style provider exits, then falls back when appropriate. Ordinary task failures do not trigger retry or fallback. |
| `thinking` | Appended as a `:level` suffix at runtime unless a suffix is already present. |
| `systemPromptMode` | `append` by default; `replace` discards Pi's base prompt. |
| `inheritProjectContext` | Uses Pi's native context-file loading policy; `false` passes `--no-context-files`. |
| `inheritSkills` | Keeps or strips Pi’s discovered skills catalog. |
| `defaultContext` | Optional `fresh` or `fork` launch context default for this agent. |
| `skills` | Injects specific skills directly, regardless of `inheritSkills`. |
| `output` | Default single-agent output file. |
| `defaultReads` | Files to read before running in chain/parallel behavior. |
| `defaultProgress` | Maintain `progress.md`. |
| `completionGuard` | Opt in with `true` to require an observed successful mutating tool result. Disabled by default; task wording never determines success. An explicit `acceptance` contract takes precedence and can allow valid no-op outcomes. |
| `interactive` | Parsed for compatibility but not enforced in v1. |
| `maxSubagentDepth` | Defaults to `0`; raise it explicitly for an agent allowed to delegate, subject to the inherited global limit. |
| `maxExecutionTimeMs` | Stops each child attempt after the given number of milliseconds, with a fresh budget for each self-review turn. |
| `maxTokens` | Bounds the child's assistant input plus output tokens per attempt, including separate self-review attempts. It is not a cumulative workflow or nested-usage budget. Enforcement is best-effort because usage arrives after model events. |

### Tool and extension selection

All bundled agents omit `tools` and `extensions` allowlists. If `tools` is omitted, `pi-subagents` does not pass `--tools`, so the child keeps Pi’s configured builtin tools and tools from loaded extensions. If `tools` is present, regular tool names become an explicit allowlist. `mcp:` entries are split out and forwarded as direct MCP selections. Path-like `tools` entries, such as extension paths or `.ts`/`.js` files, are treated as tool-extension paths rather than builtin tool names. Tool capabilities and task prose do not imply a mutation requirement. Use `completionGuard: true` only when a successful mutating tool result is explicitly required, or use `acceptance` with real verification commands for stronger evidence.

Examples:

- `tools` omitted and `extensions` omitted: configured builtins and normal extensions, including their tools.
- `allowSubagents: true` with `tools` omitted: normal tools plus child-safe `delegate`, `agent_runs`, and `load_subagent`. The full `subagent` tool loads on demand. A first-level child remains blocked until both the agent and installation set `maxSubagentDepth` to at least `2`.
- `tools: mcp:chrome-devtools`: normal builtins plus direct Chrome DevTools MCP tools.
- `tools: read, bash, mcp:chrome-devtools`: only `read` and `bash` as builtins, plus direct Chrome DevTools MCP tools.
- `tools: subagent, read`: the explicitly requested child-safe `subagent` tool stays active, alongside compact delegation tools. A first-level child remains blocked until both the agent and installation set `maxSubagentDepth` to at least `2`.
- `allowSubagents: true` with an explicit regular tool allowlist: the launcher adds compact delegation tools and permits the advanced tool for lazy loading. Other tools retain their existing selection.

Direct MCP tools require [pi-mcp-adapter](https://github.com/fitchmultz/pi-mcp-adapter). By default, children preserve the adapter’s configured direct tools and any inherited `MCP_DIRECT_TOOLS` setting. Explicit `mcp:` entries override that selection; explicit `tools` and `extensions` allowlists still apply. The generic `mcp` and `mcp_script` tools remain available when enabled by the adapter and not excluded by an explicit allowlist. The adapter caches tool metadata at startup, so after connecting a new MCP server for the first time, restart Pi before relying on direct tools. An `mcp:` entry named `subagent` does not authorize nested fanout; explicit opt-in requires `allowSubagents: true` or the builtin `subagent` tool name plus both agent and global depth limits of at least `2`.

`extensions` controls child extension loading:

```yaml
# Omitted: all normal extensions load

# Empty: no extensions
extensions:

# Allowlist
extensions: /abs/path/to/ext-a.ts, /abs/path/to/ext-b.ts
```

When `extensions` is present, it takes precedence over extension paths implied by `tools` entries.

## Chain files

Chains are reusable workflows stored separately from agent files. Use `.chain.md` for simple sequential saved chains. Use `.chain.json` when a chain needs dynamic fanout.

| Scope | Path |
|-------|------|
| User | `~/.pi/agent/chains/**/*.chain.md`, `~/.pi/agent/chains/**/*.chain.json` |
| Project | `.pi/chains/**/*.chain.md`, `.pi/chains/**/*.chain.json` |

Nested subdirectories are discovered recursively. If both `.chain.md` and `.chain.json` define the same parsed runtime chain name in the same scope, `.chain.json` wins. If user and project scopes define the same parsed runtime chain name, the project chain wins. Chains support the same optional `package` frontmatter as agents; `name: review-flow` plus `package: code-analysis` runs as `code-analysis.review-flow`.

Example:

```md
---
name: scout-planner
description: Gather context then plan implementation
---

## scout
phase: Context
label: Map auth flow
as: context
output: context.md

Analyze the codebase for {task}

## planner
phase: Planning
label: Implementation plan
reads: context.md
model: anthropic/claude-sonnet-4-5:high
progress: true

Create an implementation plan based on {outputs.context}
```

Each `.chain.md` `## agent-name` section is a step. Config lines such as `phase`, `label`, `as`, `outputSchema`, `output`, `outputMode`, `reads`, `model`, `skills`, and `progress` go immediately after the header. A blank line separates config from task text. In saved `.chain.md` files, `outputSchema` is a path to a JSON Schema file; direct tool calls and `.chain.json` files can pass the schema object inline.

For task text containing `##` headings, use a `task-json` config line containing a JSON string instead of a prose body, for example `task-json: "Review the change.\n\n## Requirements\nDo not modify files."`. Managed create/update saves use this form automatically when needed, preserving the headings as task text rather than extra steps.

For `output`, `reads`, `skills`, and `progress`, chain behavior is three-state: omitted inherits from the agent, a value overrides, and `false` disables.

Use `phase` to group related work in status output, `label` for a readable step name, and `as` to store a successful step or parallel task result for later `{outputs.name}` references. Duplicate `as` names, invalid identifiers, and unknown output references fail before child execution.

Dynamic fanout is available only through direct `subagent({ chain: [...] })` JSON or saved `.chain.json` files. It expands an array from a prior structured named output, runs one child template per item, and stores the ordered collection under `collect.as`. The source must be structured output; prose is never parsed. `expand.maxItems` is required, over-limit arrays fail, nested fanout and arbitrary expressions are not supported, and `.chain.md` has no dynamic syntax in this release.

```json
{
  "name": "dynamic-analysis",
  "description": "Find migration targets, inspect them in parallel, then synthesize a plan.",
  "chain": [
    {
      "agent": "scout",
      "task": "Return {\"items\":[{\"path\":\"...\",\"reason\":\"...\"}]} via structured_output.",
      "as": "targets",
      "outputSchema": { "type": "object" }
    },
    {
      "expand": {
        "from": { "output": "targets", "path": "/items" },
        "item": "target",
        "key": "/path",
        "maxItems": 12
      },
      "parallel": {
        "agent": "scout",
        "label": "Inspect {target.path}",
        "task": "Inspect {target.path}. Reason: {target.reason}",
        "outputSchema": { "type": "object" }
      },
      "collect": { "as": "analyses" },
      "concurrency": 4
    },
    {
      "agent": "planner",
      "task": "Synthesize a migration plan from {outputs.analyses}"
    }
  ]
}
```

Create simple `.chain.md` chains by writing files directly or with the `subagent({ action: "create", config: ... })` management action. Create dynamic `.chain.json` chains by writing the JSON file directly. Run saved chains with natural language or:

```text
/run-chain scout-planner -- refactor authentication
```

## Chain variables

Task templates support:

| Variable | Description |
|----------|-------------|
| `{task}` | Original task from the first step. |
| `{previous}` | Output from the prior step, or aggregated output from a parallel step. |
| `{chain_dir}` | Path to the chain artifact directory. |
| `{outputs.name}` | Text value from a prior step or completed parallel task with `as: "name"`. |

Parallel outputs are aggregated with clear separators before being passed to the next step:

```text
=== Parallel Task 1 (worker) ===
...

=== Parallel Task 2 (worker) ===
...
```

## Skills

Skills are `SKILL.md` files injected into an agent’s system prompt.

Discovery uses project-first precedence:

1. `.pi/skills/{name}/SKILL.md`
2. Project packages and project settings packages via `package.json -> pi.skills`
3. Current task cwd package via `package.json -> pi.skills`
4. `.pi/settings.json -> skills`
5. `~/.pi/agent/skills/{name}/SKILL.md`
6. User packages and user settings packages via `package.json -> pi.skills`
7. `~/.pi/agent/settings.json -> skills`

Use agent defaults, override them at runtime, or disable them:

```ts
{ agent: "scout", task: "..." }
{ agent: "scout", task: "...", skill: "tmux, safe-bash" }
{ agent: "scout", task: "...", skill: false }
```

For chains, named `skill` values at the top level are additive. Top-level `skill: false` disables inherited, agent, and step skills for every step. A step-level `skill` otherwise overrides that step; step-level `false` disables all skills for that step.

Injected skills use this shape:

```xml
<skill name="safe-bash">
[skill content from SKILL.md, frontmatter stripped]
</skill>
```

Missing skills do not fail execution. The result summary shows a warning.

### Bundled skill

The package bundles a `pi-subagents` skill that is automatically available to the parent agent when the extension is installed. It is for the orchestrating parent only: child subagents never receive it, and their context is explicitly filtered to strip parent-only orchestration instructions.

What the bundled skill covers:
- **Delegation patterns**: when to launch which agent, whether to use single, parallel, chain, or async mode, and whether to use fresh or forked context
- **Workflow recipes**: how to apply the example techniques directly with `subagent(...)` when the user describes the workflow in natural language. This includes parallel review, review-loop, parallel research, parallel context-build, parallel handoff-plan, gather-context-and-clarify, and parallel cleanup
- **Role-agent prompting guidance**: compact contract prompts instead of long scripts, what to include in role-specific meta prompts, and retrieval budgets for researchers
- **Delegation boundaries**: helpers stay within their assigned scope and configured permissions/depth; agents must not invent Intercom targets or expand unapproved scope
- **Intercom conventions**: when to ask vs send, and how parent-side result delivery works with `pi-intercom`
- **Control and diagnostics**: attention signals, soft interrupts, status, and the `doctor` action

If you are writing an agent that orchestrates subagents, the bundled skill helps it behave correctly without guessing the patterns. If you are a human user, you do not need to read it directly; the README and example prompts encode the same workflows in user-facing form.

## Programmatic tool usage

These are the parameters the LLM passes when it calls the `subagent` tool. Most users ask naturally or use slash commands instead.

### Everyday and advanced schemas

`delegate` and `agent_runs` use closed parameter schemas with local validation, without provider-side strict sampling. Their acceptance criteria use `{ id, must, evidence?, severity? }` objects, and verification environments use unique `{ name, value }` pairs. Duplicate environment names are rejected before execution.

```ts
delegate({
  agent: "worker",
  task: "Implement the approved fix",
  acceptance: {
    criteria: [{ id: "fix", must: "Fix the reproduced bug without changing the public API" }],
    evidence: ["changed-files", "commands-run", "residual-risks"],
    verify: [{ id: "unit", command: "npm test", env: [{ name: "CI", value: "1" }] }],
    maxFinalizationTurns: 3
  }
})
```

`load_subagent` activates the advanced `subagent` schema on demand. It retains string or object acceptance criteria, environment maps, arbitrary caller-supplied output schemas, workflows, and detailed launch overrides. Those flexible inputs do not require strict conversion. Child `structured_output` submissions are still validated against the requested schema; constrained sampling depends on native model and schema support.

### Execution examples

```ts
// Single agent
{ agent: "worker", task: "refactor auth" }
{ agent: "scout", task: "find todos", maxOutput: { lines: 1000 } }
{ agent: "scout", task: "investigate", output: false }
{ agent: "scout", task: "write a large report", output: "reports/scout.md", outputMode: "file-only" }

// Forked context
{ agent: "oracle", task: "review this thread", context: "fork" }

// Parallel
{ tasks: [{ agent: "scout", task: "a" }, { agent: "researcher", task: "b" }] }
{ tasks: [{ agent: "scout", task: "audit auth", count: 3 }] }
{ tasks: [{ agent: "scout", task: "audit frontend" }, { agent: "oracle", task: "review backend constraints" }], context: "fork" }

// Chain
{ chain: [
  { agent: "scout", task: "Gather context for auth refactor" },
  { agent: "planner" },
  { agent: "worker" }
]}

// Wait for the same owner's result
{ chain: [...], async: false }

// Chain with fan-out/fan-in
{ chain: [
  { agent: "scout", task: "Gather context", phase: "Context", label: "Map code", as: "context" },
  { parallel: [
    { agent: "scout", task: "Audit frontend from {outputs.context}", label: "Frontend", as: "frontend" },
    { agent: "researcher", task: "Research API constraints from {outputs.context}", label: "API", as: "api" }
  ], concurrency: 2, failFast: true },
  { agent: "planner", task: "Create a plan from {outputs.frontend} and {outputs.api}" }
]}

// Dynamic fanout from structured output
{ chain: [
  {
    agent: "scout",
    task: "Return migration targets as structured_output: { items: [{ path, reason }] }",
    as: "targets",
    outputSchema: { type: "object" }
  },
  {
    expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 12 },
    parallel: { agent: "scout", task: "Inspect {target.path}. Reason: {target.reason}", outputSchema: { type: "object" } },
    collect: { as: "analyses" },
    concurrency: 4
  },
  { agent: "planner", task: "Synthesize a migration plan from {outputs.analyses}" }
] }

// Strict structured output for reliable handoff data
{ chain: [
  {
    agent: "scout",
    task: "Return the key files and risks for {task}",
    as: "scan",
    outputSchema: {
      type: "object",
      required: ["files", "risks"],
      properties: {
        files: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } }
      }
    }
  },
  { agent: "planner", task: "Plan from this scan: {outputs.scan}" }
] }

// Worktree isolation
{ tasks: [
  { agent: "worker", task: "Implement auth" },
  { agent: "worker", task: "Implement API" }
], worktree: true }
```

### Management actions

Agent definitions are not loaded into context by default. Management actions let the LLM discover, inspect, create, update, and delete agents and chains at runtime. `list` and `get` show the effective runtime agent by default, so user/project agents that shadow a builtin appear once with the same precedence used for execution (`project` > `user` > `builtin`). Pass `agentScope: "user"` or `agentScope: "project"` to inspect a specific shadowing scope.

```ts
{ action: "list" }
{ action: "list", agentScope: "project" }
{ action: "get", agent: "scout" }
{ action: "get", agent: "code-analysis.scout" }
{ action: "get", chainName: "review-pipeline" }

{ action: "create", config: {
  name: "Code Scout",
  package: "code-analysis",
  description: "Scans codebases for patterns and issues",
  scope: "user",
  systemPrompt: "You are a code scout...",
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  model: "anthropic/claude-sonnet-4",
  fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  tools: "read, bash, mcp:github/search_repositories",
  extensions: "",
  skills: "parallel-scout",
  thinking: "high",
  output: "context.md",
  reads: "shared-context.md",
  progress: true
}}

{ action: "create", config: {
  name: "analysis-pipeline",
  description: "Scout then plan",
  scope: "project",
  steps: [
    { agent: "scout", task: "Scan {task}", output: "context.md" },
    { agent: "planner", task: "Plan from {previous}", reads: ["context.md"] }
  ]
}}

{ action: "update", agent: "code-analysis.scout", config: { model: "openai/gpt-4o" } }
{ action: "update", chainName: "analysis-pipeline", config: { steps: [...] } }
{ action: "delete", agent: "scout" }
{ action: "delete", chainName: "analysis-pipeline" }
```

`create` uses `config.scope`, not `agentScope`. `config.name` is the local frontmatter name; optional `config.package` registers the runtime name as `{package}.{name}` and is saved as separate `name` and `package` frontmatter. `get` uses effective runtime precedence by default and can be narrowed with `agentScope`. `update` and `delete` use the runtime name and `agentScope` only when the same runtime name exists in multiple mutable scopes. To clear optional string fields, including `package`, set them to `false` or `""`.

### Parameter reference

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name for single mode, or target for management actions. |
| `task` | string | - | Task string for single mode. |
| `action` | string | - | `list`, `get`, `create`, `update`, `delete`, `status`, `interrupt`, `extend`, `resume`, `nudge`, `questions`, `answer`, `review`, or `doctor`. |
| `questionId` | string | - | Required with `id` and `message` for `action: "answer"`. |
| `decision` | `accepted \| needs_changes` | - | Parent review outcome for `action: "review"`; optional `message` adds a note. |
| `offset` / `limit` | integer | 0 / 20 | Page the attention-first `status` list; limit is 1–100. Live work precedes completed unreviewed results. Exact-ID lookup is unbounded. |
| `full` | boolean | false | Exact `status`/`agent_runs` inspect: include the full task and saved launch configuration. |
| `chainName` | string | - | Chain name for management actions. |
| `config` | object/string | - | Agent or chain config for create/update. |
| `output` | `string \| false` | agent default | Override single-agent output handoff file. Explicit caller paths persist at their resolved cwd/workspace path; agent-default relative paths are materialized under run artifacts. |
| `outputMode` | `"inline" \| "file-only"` | `inline` | Inline mode returns the saved content plus an output reference. `file-only` returns only a compact persistent-file reference and requires an `output` path. |
| `skill` | `string \| string[] \| false` | agent default | Override skills or disable all. |
| `model` | string | agent default | Override model. |
| `tasks` | array | - | Top-level parallel tasks. Supports `agent`, `task`, `cwd`, `count`, `outputSchema`, `output`, `outputMode`, `reads`, `progress`, `skill`, `model`, and `acceptance`. |
| `concurrency` | number | config or `4` | Top-level parallel concurrency. |
| `timeoutMs` / `maxRuntimeMs` | number | - | Owner-enforced wall-clock timeout for waiting single, parallel, and chain runs. When `async` is omitted, either field requests a wait. Explicit async/background calls reject it. Short reviewer budgets are raised to a safe floor; planner/researcher-style budgets are raised only from local run-history duration data. For `action: "extend"`, `timeoutMs`/`maxRuntimeMs` can also supply the extension amount when `extendMs` is omitted. |
| `extendMs` | number | - | Additional milliseconds for `action: "extend"`. |
| `worktree` | boolean | false | Create isolated git worktrees for parallel tasks. |
| `chain` | array | - | Sequential, static parallel, and dynamic fanout chain steps. Sequential steps and parallel child tasks support `phase`, `label`, `as`, `outputSchema`, and `acceptance` in addition to the usual execution fields. Dynamic fanout uses `expand`, one child `parallel` template, and `collect`; group-level acceptance is not supported because there is no child session to finalize. |
| `context` | `fresh \| fork` | agent default or `fresh` | `fork` creates real branched sessions from the parent leaf. Packaged `oracle` defaults to `fork`; the other Fitch role profiles default to `fresh`. Fork is rejected for effective `anthropic/` primary or fallback models. |
| `chainDir` | string | temp chain dir | Persistent directory for chain artifacts. |
| `clarify` | boolean | false | Show TUI preview/edit flow only when explicitly set to `true`. |
| `agentScope` | `user \| project \| both` | `both` | Agent discovery scope. Project wins on collisions. |
| `async` | boolean | top-level: true | Background delivery from the shared owner. Set `false` to wait for the saved result. Child-safe nested calls default to waiting so their results can appear in the calling child's report; `clarify: true` and timeout fields also request a wait. Native async result routing additionally requires host/model capability and an actual pending call. |
| `cwd` | string | selected execution cwd | Override working directory. Relative paths resolve from the parent's current selection; omitted continuation cwd retains the saved child launch and selection. Without a directory extension, use native Pi cwd. |
| `progress` | boolean | agent default | Maintain `progress.md` for a single run. Parallel task-level progress is maintained in each task cwd; chain progress is maintained in `chainDir`. |
| `maxOutput` | object | 200KB, 5000 lines | Final output truncation limits. |
| `artifacts` | boolean | true | Write input, output, and metadata debug artifacts. JSONL is not written. |
| `includeProgress` | boolean | false | Include full progress in result. |
| `control` | object | enabled, 10-minute idle threshold | Override needs-attention tracking (`enabled`, `needsAttentionAfterMs`, `failedToolAttemptsBeforeAttention`, `notifyOn`, `notifyChannels`). |
| `share` | boolean | false | Upload session export to GitHub Gist. |
| `sessionDir` | string | derived | Override session log directory. |
| `acceptance` | object | omitted | Explicit criteria/evidence/verification contract. When present, the child gets a structured contract, then the runtime continues the same session for a bounded self-review/repair loop before evaluating acceptance. Launch independent reviewers separately from the parent. |

`context: "fork"` fails fast when an affected agent's effective primary or fallback model uses the `anthropic/` provider, the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created. The Anthropic restriction cannot be bypassed with explicit context or model overrides, and fork never silently downgrades to `fresh`. When a multi-agent run omits `context`, each child uses its own `defaultContext`: a fresh-default scout or reviewer stays fresh even when batched with fork-default `oracle`. Other providers continue to use these agent defaults and explicit context overrides normally.

By default, `output` paths are handoff files. Explicit `output` paths are resolved from the task cwd and left in place, so workspace paths like `.scratchpad/scout.md` remain readable after the run. Reports inside disposable worktrees are copied to the durable run directory before cleanup; returned file references point to that surviving copy even with `artifacts: false`. Relative output paths that come only from an agent default are materialized under the run artifact directory as unique files, so parallel defaults like `context.md` or `review.md` do not collide and do not create project-root leftovers. In inline mode, the runtime reads the handoff content into the parent result and records `savedOutputPath`/`outputReference`; when a materialized agent-default file is consumed, the result records `outputCleanup`. Session artifacts still expose `artifactPaths.outputPath` when artifacts are enabled.

Use `outputMode: "file-only"` when the parent only needs a pointer. The returned text is a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Failed runs and save errors still return normal inline output for debugging. In chains, later `{previous}` steps receive the same compact reference when the prior step used file-only mode.

Single, top-level parallel, sequential chain, and parallel chain tasks accept `outputSchema`. If `outputSchema` is present, the child must call `structured_output` with schema-valid JSON; prose-only completion or invalid JSON fails the step. Validated structured values are preserved on the step result, and `as` also exposes a compact text representation through `{outputs.name}` for chain steps.

Status and control actions:

```ts
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id>" })
subagent({ action: "status", id: "<nested-run-id>" })
subagent({ action: "interrupt", id: "<run-id>" })
subagent({ action: "interrupt", id: "<nested-run-id>" })
subagent({ action: "extend", id: "<run-id>", extendMs: 300000 })
subagent({ action: "resume", id: "<run-id>", message: "follow-up question" })
subagent({ action: "resume", id: "<run-id>", index: 1, message: "follow-up for child 2" })
subagent({ action: "resume", id: "<nested-run-id>", message: "follow-up for a nested child" })
subagent({ action: "nudge", id: "<run-id>", message: "What are you blocked on?" })
subagent({ action: "review", id: "<run-id>", decision: "needs_changes", message: "One edge case remains." })
subagent({ action: "status", offset: 20, limit: 20 })
subagent({ action: "doctor" })
```

`status` resolves exact run IDs, including legacy foreground IDs and nested run IDs, before falling back to prefix matching. Completed, failed, and interrupted owned runs remain inspectable after reload or restart of the same saved parent. `id: "latest"` / `id: "last"` selects the latest owned run; exact IDs are retained regardless of list size. Nested status shows the root/parent path, nested children, session/artifact paths when known, and nested control commands. Inside child-safe fanout mode, `agent_runs({ action: "list" })` lists only the child's directly owned runs restored from its saved session. Use an explicit run ID for advanced `status`; children cannot enumerate unrelated top-level runs. Bare `interrupt` still targets only the visible top-level run; interrupting a nested run requires its explicit nested id.

`extend` targets an active run with an existing timeout and requests more milliseconds on its deadline. The receipt says **requested** until the owner applies it. It is useful when progress or a needs-attention notice shows useful work still happening and throwing away the child session would waste context. It cannot revive an already-timed-out run; use `resume` after timeout.

`resume` sends the follow-up directly when the child is still reachable over Intercom. After completion, it starts a new owned continuation from the stored child session file. For multi-child runs, including remembered legacy foreground runs, pass `index` to choose the child. Nested runs can be resumed by nested ID when their live route or persisted nested session metadata is available. Timed-out or transient-error children use the same revival path when their `.jsonl` session file was persisted. Revived children reuse their saved effective launch configuration, including the original explicit acceptance contract. Explicit resume overrides replace the corresponding choices only on a newly launched continuation, never a live child's acceptance. `agent` opts into a current profile; old runs without a profile snapshot require that choice. Revive starts a new child process from the old session context; it does not restart the same OS process, and it requires the chosen child to have a persisted `.jsonl` session file.

`nudge` sends a short non-blocking steered Intercom message to a live child. Use it for guidance, answers, corrections, or blockers that may affect active work. The child treats it as supplemental coordination and continues its current task unless the message explicitly replaces it. It requires the bundled intercom extension and a registered child target. Use the `Ask:` command shown by `status` only when the parent must remain alive waiting for a reply.

## Worktree isolation

Parallel agents can clobber each other if they edit the same checkout. `worktree: true` gives each parallel child its own git worktree branched from `HEAD`.

```ts
{ tasks: [
  { agent: "worker", task: "Implement auth", count: 2 },
  { agent: "worker", task: "Implement API" }
], worktree: true }

{ chain: [
  { agent: "scout", task: "Gather context" },
  { parallel: [
    { agent: "worker", task: "Implement feature A from {previous}" },
    { agent: "worker", task: "Implement feature B from {previous}" }
  ], worktree: true },
  { agent: "planner", task: "Create an integration plan for all changes from {previous}" }
]}
```

Requirements:

- run inside a git repo
- working tree must be clean
- dependencies belong to each worktree; install them there with the project's package manager, or automate installation with `worktreeSetupHook`. The original checkout's `node_modules/` is not shared, so workspace imports resolve the child's code
- task-level `cwd` overrides must be omitted or match the shared cwd
- configured `worktreeSetupHook` must return valid JSON before timeout

Stop and run deadlines also cancel Git checkout and setup hooks. Failed or interrupted setup rolls back newly created worktrees within the setup-hook timeout and reports anything it cannot remove.

After a worktree parallel step completes, per-agent diff stats are appended to the output and full patch files are written to artifacts. Worktrees and temp branches are then cleaned up. Runner exceptions or diff-capture failures preserve them so edits remain recoverable.

## Configuration

`pi-subagents` reads optional JSON config from `~/.pi/agent/extensions/subagent/config.json`.

### `asyncByDefault`

Background delivery is the stock top-level default. Make calls wait by default if needed:

```json
{ "asyncByDefault": false }
```

The setting applies when a top-level tool or slash call does not explicitly set `async`. Child-safe nested calls default to waiting unless `asyncByDefault: true` is explicitly configured; set `async: false` when their result must appear in the calling child's report. Top-level callers can request a wait with `async: false` unless `forceTopLevelAsync` is enabled. The run owner and child driver are the same either way.

### `compactChildTools`

Authorized children start with `delegate`, `agent_runs`, and `load_subagent`; the full `subagent` schema loads on demand. Advanced tools reset to the compact selection on session start, tree navigation, and compaction. A pending native `subagent` call keeps that tool active so its original result can recover; the next reset after completion hides it again. Explicit `tools: subagent` profiles keep the advanced tool active. Agent-definition mutations remain blocked in children, including after loading.

Set this flag to `false` to restore the previous full `subagent`-only child surface:

```json
{ "compactChildTools": false }
```

The default is `true`. Restart children after changing the setting. It does not change models, thinking levels, depth limits, execution defaults, run ownership, or the parent tool surface.

### `forceTopLevelAsync`

```json
{ "forceTopLevelAsync": true }
```

Forces depth-0 single, parallel, and chain calls to request background delivery and bypasses clarify UI by forcing `clarify: false`. Nested calls keep their own inherited settings. This does not enable a host's native async API.

### `parallel`

```json
{
  "parallel": {
    "maxTasks": 12,
    "concurrency": 6
  }
}
```

`maxTasks` defaults to `8`; `concurrency` defaults to `4`. Per-call `concurrency` takes precedence.

### `defaultSessionDir`

```json
{ "defaultSessionDir": "~/.pi/agent/sessions/subagent/" }
```

Session directory precedence is: `params.sessionDir`, then `config.defaultSessionDir`, then a directory derived from the parent session. Sessions are always enabled.

### `projectTrust`

```json
{ "projectTrust": { "childRuns": "approve" } }
```

Controls project-trust flags for non-interactive child `pi` processes. Child runs default to `approve` so subagents see the same project-local instructions, settings, skills, and extensions the parent trusted. If the parent Pi process was explicitly started with `--no-approve`, child runs keep `--no-approve`. Set `"childRuns": "inherit"` to only forward the parent CLI trust flag, or `"childRuns": "no-approve"` to force children to ignore project-local inputs.

### `maxSubagentDepth`

```json
{ "maxSubagentDepth": 1 }
```

Controls nested delegation when no inherited `PI_SUBAGENT_MAX_DEPTH` is already in effect. The default is `1`, which allows the main session to launch subagents and blocks those children from delegating again. Per-agent `maxSubagentDepth` can tighten the limit for that agent’s child runs, but cannot relax an inherited stricter limit.

Agent profiles separately default `maxSubagentDepth` to `0`. A first-level child runs at depth `1`, so nested orchestration requires both the installation and that orchestrator profile to set `maxSubagentDepth` to at least `2`.

### Agent resource limits

Set `maxExecutionTimeMs` and `maxTokens` in agent frontmatter or through `subagent({ action: "create" | "update", config })` to bound each attempt for a specific agent. Retry, fallback, and self-review attempts receive their own budgets; these limits do not become cumulative workflow caps.

```yaml
maxExecutionTimeMs: 600000
maxTokens: 50000
```

When a limit is reached, the child receives a soft interrupt, the run fails with a clear `Resource limit exceeded...` error, and the result includes `resourceLimitExceeded` with the limit kind, configured limit, and observed token count when available. Resource-limit failures do not trigger fallback model retries. `maxTokens` is best-effort because providers report usage after message events; a child may exceed the exact limit before the runtime can stop it.

Spawn-count and per-agent child-concurrency quotas are not part of this release; use `maxSubagentDepth` and parallel `concurrency` for those boundaries today.

### Intercom pairing

Intercom wiring is always on and bundled with `pi-subagents`. Children receive fixed default bridge instructions and parent-side result/control delivery uses the resolved orchestrator target automatically. If an agent sets an explicit `extensions` allowlist, include `pi-intercom` so child-side `intercom` and `contact_supervisor` tools stay available.

The injected guidance tells children to use steered blocking `contact_supervisor` decisions or structured interviews only when the ephemeral child cannot safely continue and must remain alive for the answer, non-blocking steered `progress_update` for material discoveries needed during active work, and generic intercom only as fallback plumbing. Supervisor nudges supplement the active task unless they explicitly replace it; routine completion still returns through normal child results.

### `worktreeSetupHook`

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

The hook runs once per created worktree. Paths must be absolute, `~/...`, or repo-relative; bare command names are rejected.

stdin is a JSON object with `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`. stdout must be one JSON object, for example:

```json
{ "syntheticPaths": [".venv", ".env.local"] }
```

`syntheticPaths` must be relative to the worktree root. They are removed before diff capture so helper files do not pollute patches. Tracked files are never excluded; marking a tracked path as synthetic fails setup. Default timeout is `30000` ms.

## Files, logs, and observability

Each chain run creates a user-scoped temp directory like:

```text
<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/
```

It may contain files such as `context.md`, `plan.md`, `progress.md`, and `parallel-{stepIndex}/.../output.md`. Directories older than 24 hours are cleaned up on extension startup.

Debug artifacts live under `{sessionDir}/subagent-artifacts/` or a user-scoped temp artifact directory. Per task you may see:

- `{runId}_{agent}_input.md`
- `{runId}_{agent}_output.md`
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, exit code, final model, attempted models, fallback attempt outcomes, acceptance details when configured, and any resource-limit termination reason. Completion notices and compact delivery receipts include existing result/metadata paths so a short worker summary does not hide that evidence. Disabled artifacts do not create metadata paths.

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts with `--session <branched-session-file>` produced from the parent’s current leaf. That is a real session fork, not an injected summary.

Native parent `subagent-run` entries store ownership, continuation links, delivery receipts, and parent review outside model context. They are restored from the full saved session, not only its current context window. Native asynchronous invocations also retain their original call binding in `subagent-invocation` entries.

New runs use storage version 2 under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/subagent-runs/<run-id>/`. The detached owner is the sole writer of execution status and the final result. Controls submit separate identified requests; questions, answers, revival claims, parent review, and UI state retain their own ownership. Inspection reads the owner's evidence without rewriting its execution state or fabricating a successful result. No separate task service or database is used.

The saved configuration retains profile choices and selected skill text, not copies of installed extensions or inherited project files. Those resources remain live. Debug artifacts and caller-owned output files can still be removed independently; inspection reports missing session/artifact paths, and a saved conversation alone never proves successful execution.

A run directory contains:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/subagent-runs/<run-id>/
  launch.json             # Frozen launch configuration
  status.json             # Owner-published progress
  result.json             # Canonical final result
  question-owner.json
  contracts/<index>.json
  questions/
  events.jsonl
  output-<n>.log
  subagent-log-<run-id>.md
```

`status.json` powers the Agents view and run inspection. Reloading or resuming the same saved parent restores its active runs from durable records. `events.jsonl` contains owner and child JSON events annotated with run and step metadata, except streaming `message_update` deltas and cumulative `tool_execution_update` progress, whose final content `message_end` and `tool_execution_end` record; `output-<n>.log` is a live readable tail. Results retain per-child outcomes, acceptance evidence, fallback attempts, output references, and worktree patch paths, including completed siblings when a workflow fails or pauses. Nested summaries reference compact sidecar records rather than copying recursive status snapshots.

Temporary cleanup does not remove these canonical records. Legacy temporary run directories and `foreground.json` snapshots remain readable. Active old owners drain on their original runtime; recovery does not replay their side effects, guess missing launch settings, or delete native session history. Missing or ambiguous evidence remains unavailable.

The result watcher emits `subagent:async-complete` for the saved parent's delivery and accounting. Runs with a waiting tool or native pending-call owner suppress ordinary completion notices; the canonical result remains available after delivery.

### Usage accounting

Child usage comes from finalized native records after the attempt's launch baseline. Inherited fork history and nonbillable checkpoints are excluded. Retries, self-review, summaries, and nested tool usage are included once, with recorded provider/model attribution; unavailable attribution is explicit. Reasoning tokens are part of output tokens, and one-hour cache writes are part of cache writes, not extra totals.

On hosts exposing idempotent `recordUsage`, finalized child contributions enter the parent's totals at completion using stable native entry IDs. Reopening the parent or reading the result again does not charge them again. On portable hosts, the finalized execution/wait tool result carries each contribution once when Pi persists that message. A launch receipt, custom completion notification, or slash-command result card alone does not add child usage to parent totals. Portable fire-and-forget background work therefore does not automatically enter the parent's usage totals. Run inspection and streaming progress never charge usage. Subscription-route cost fields remain estimates, not invoices.

## Acceptance Gates

`acceptance` is an explicit contract. Omit it for lightweight runs. For review-only tasks, omit it unless the user explicitly requests a same-session acceptance contract; the extra finalization turn is not independent review. Set it on single runs, top-level parallel task items, sequential chain steps, static parallel task items, and dynamic fanout child templates when the child must prove the work meets concrete criteria. Do not set it on static parallel groups or dynamic fanout aggregate groups; those groups do not own a same-session child turn.

`no-staged-files` requires the **entire Git index** to be empty, including paths staged before the child started. It does not mean only files changed by that child. A parent contract requiring both a staged deliverable and `no-staged-files` is contradictory; the runtime does not weaken the check or alter the index to reconcile it.

If you are coming from Codex Goals, `acceptance` is the subagent equivalent for one delegated run. When a user says `/goal`, “goal”, “active goal”, “continue until evidence says done”, or “verify against a goal”, translate that into an acceptance contract: `criteria` are the target, `evidence` and `verify` are proof, `stopRules` are constraints, and `maxFinalizationTurns` is the bounded loop budget.

```ts
{
  agent: "worker",
  task: "Implement the fix",
  acceptance: {
    criteria: ["Patch the bug without widening scope"],
    evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"],
    verify: [{ id: "unit", command: "npm run test:unit", timeoutMs: 120000 }],
    maxFinalizationTurns: 3
  }
}
```

When `acceptance` is present, the initial child prompt includes a standardized contract and asks for a fenced `acceptance-report` JSON block. After the initial completion, mandatory bounded self-review continues the same persisted child session. Pi-backed children keep that review inside the same native CLI process; Claude Code uses its native session continuation through the shared adapter. The child can repair omissions before submitting its final report. Missing or malformed reports reject the run when the loop limit is reached. The final answer replaces the initial answer and must stand alone with every requested handoff detail, including paths, identifiers, findings, and cumulative evidence.

Native Pi finalization uses `structured_output({ value: { answer, report } })`: `answer` is the complete standalone answer, and `report` is a typed acceptance object, not JSON embedded in a string. Only the current attempt's latest assistant turn can submit the report, as its sole tool call. The call needs a matching successful result and an identical saved capture. Later assistant activity requires resubmission; passive context without a new model turn does not. Settlement or exit code zero alone never proves acceptance.

Missing or stale submissions retry only within `maxFinalizationTurns`; an exhausted run is rejected with the prior full report retained as **UNCONFIRMED** audit evidence. With `outputSchema`, finalization's `answer` is the current JSON payload validated against that schema. It replaces the initial structured result and capture used by named outputs and dynamic fanout; the acceptance `report` remains private. Claude Code submits this same envelope through its native structured-result API when `outputSchema` is present, and keeps its fenced-report contract otherwise. Runtime verification commands run as cancellable work in the owner after self-review, against the final state; child-reported commands do not substitute for them.

Public acceptance config is evidence-driven. There is no public `level` field and no `acceptance: "checked"` shorthand. Runtime provenance is derived from what actually happened:

- `attested`: the child returned a structured acceptance report.
- `checked`: runtime structural checks passed, such as required criteria, required evidence, and no staged files.
- `verified`: configured runtime verification commands passed. Child-reported command success does not count.
- `rejected`: attestation, structural checks, verification, or finalization failed.

Independent review is not part of `acceptance`; the parent launches reviewer runs after the worker completes. Unsupported `acceptance.review` input fails during preflight before any child starts. Self-review finalization never counts as independent review, and it never counts as `verified` unless configured runtime verification commands actually pass. Child-written handoff files remain authoritative during finalization. Otherwise, the current finalization report supplies the parent result, chain input, and artifact output; native finalization also refreshes files generated from earlier assistant output. Legacy and Claude Code fenced reports can retain the prior handoff when they provide no new summary. The initial output remains available as acceptance audit evidence; finalization usage and residual risks are included in the result. Final reports describe cumulative whole-task evidence, including criterion-local evidence requirements, not only edits made during the finalization turn.

When delegating implementation from a plan or spec, keep the task focused on what to implement and put the definition of done in `acceptance` so the runtime can finalize and evaluate it:

```ts
subagent({
  agent: "worker",
  // Background delivery is the default; set async: false to wait for the result.
  task: "Implement the plan at /Users/me/docs/mcp-alignment-plan.md. Use scout artifacts in ./handoff/ as context. Do not commit the scout artifacts.",
  acceptance: {
    criteria: [
      "Implementation follows /Users/me/docs/mcp-alignment-plan.md",
      "Plan acceptance checks are addressed",
      "Scout handoff artifacts are not committed",
      "Focused validation for changed behavior passes",
      "Residual risks or skipped checks are reported"
    ],
    evidence: ["changed-files", "commands-run", "validation-output", "residual-risks"],
    verify: [{ id: "local-gate", command: "npm run ci" }],
    stopRules: [
      "Do not edit unrelated files",
      "Stop and report if the plan requires an unapproved product decision"
    ],
    maxFinalizationTurns: 3
  }
})
```

## Human-only acceptance blockers

A real human-only boundary, such as Touch ID or an unavailable MFA code, is **blocked**, not success or a generic failed review. Report the affected criterion with `status: "blocked"`, concrete `evidence`, and a nonempty `humanAction` stating the exact action needed. Retain completed criteria and evidence. The first valid initial or current native blocked report stops further finalization and verification, keeps acceptance incomplete, and prevents dependent workflow steps from starting. Independent siblings continue; real failures still take precedence. Plain “blocked” prose, stale submissions, malformed reports and ordinary fixable failures do not get this treatment.

The Agents view keeps these tasks visible as **Needs your action — acceptance incomplete**. After doing the requested action, use explicit Continue on the saved conversation. Inspecting, reviewing or restoring it does not retry authentication, and a blocked report does not fabricate a waiting question.

## Live progress

Waiting calls show compact live progress from the same owner used for background work: current tool, recent output, token counts, duration, activity freshness, current-tool duration, and chain graph metadata when available.

Delegation receipts, completed responses, and completion messages show compact summaries by default. Press `Ctrl+O` to expand their full responses and details, or the full streaming view with output per step. The quiet Agents strip replaces the routine async widget; Ctrl+O still exposes its advanced background details. Collapsing these views does not shorten the content sent to the model.

Sequential chains show a flow line like `done scout → running planner`. Chains with parallel steps show per-step cards instead. Chain status uses `label` and `phase` metadata when present, while falling back to agent names for older chains.

## Compact view

On a native [`fitchmultz/pi` build with compact-view support](https://github.com/fitchmultz/pi/commit/17cb62faade465700692b0d474ec5652e8df3aed), use `/compact-view on`, `/compact-view off`, or `/compact-view toggle`. `/settings` → **Compact view** controls the same setting. It defaults off, updates the current UI immediately, and saves your default for future Pi starts without changing other running sessions.

When enabled, ordinary Intercom messages, subagent notifications, and slash-command result cards use one content row plus Pi's existing blank line. Press `Ctrl+O` (or your configured expansion key) for full details. Questions, reply guidance, and needs-attention notices stay prominent. Turning the mode off restores normal presentation; older hosts without the native hint keep that presentation too. This is display-only: message content, attachments, model context, history, and delivery are unchanged. `/compact` is the separate context-compaction command.

## Session sharing

Pass `share: true` to export a full session to HTML, upload it to a secret GitHub Gist through your `gh` credentials, and return a `https://shittycodingagent.ai/session/?<gistId>` URL.

```ts
{ agent: "scout", task: "...", share: true }
```

This is disabled by default. Session data may contain source code, paths, environment variables, credentials, or other sensitive output. You need `gh` installed and authenticated.

## Recursion guard

Nested child delegation is disabled by default. The default depth guard allows one level—main session → subagent. To let a child use useful helpers within its assigned task, enable delegation in its profile and set both its profile and installation depth limits to at least `2`. This does not change bundled profile defaults or the original parent's responsibility for integration and delivery.

Configure the limit with:

1. `PI_SUBAGENT_MAX_DEPTH` before starting Pi
2. `config.maxSubagentDepth`
3. `maxSubagentDepth` in agent frontmatter, which can only tighten the inherited limit

```bash
export PI_SUBAGENT_MAX_DEPTH=1
```

`PI_SUBAGENT_DEPTH` is internal and propagated automatically. Do not set it manually; invalid values block nested subagents instead of resetting to zero.

## Events

Owner lifecycle events retain their existing names for all new runs:

- `subagent:async-started`
- `subagent:async-complete`

Intercom delivery events:

- `subagent:control-intercom`
- `subagent:result-intercom`
- `subagent:live-intercom`
- `subagent:intercom-health-request`
- `subagent:supervisor-question-resolved` — `{ questionId }` after a durable answer or explicit cancellation; clears pending-ask presence without starting a turn.

The result watcher emits `subagent:async-complete`; `src/extension/index.ts` handles saved-result accounting and notification routing. Waiting tools and native pending calls suppress ordinary completion notices. Raw control events remain in the owner's event log. Idle notices wait until the current parent turn ends and are discarded if their child has finished; previously delivered obsolete idle notices are omitted from future model context without removing saved history. Unresolved supervisor questions and completion-guard findings remain visible. A terminal completion-guard notice leaves automatic completion delivery to the matching result, avoiding two triggered turns. A parallel group delivers one aggregate result after its siblings finish; a mid-group guard notice is visible immediately. With `pi-intercom`, needs-attention notices, live nudges, best-effort child health, and portable grouped results can reach the orchestrator over Intercom.

## Prompt-template integration

`pi-subagents` works standalone through natural language, the `subagent` tool, and its built-in slash commands. The example prompts near the top of this README are not registered as commands. You can wrap subagent delegation in your own reusable Pi prompt templates.

Example:

```md
---
description: Take a screenshot
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

Then `/take-screenshot https://example.com` switches to Sonnet, delegates to `browser-screenshoter` with `/tmp/screenshots` as cwd, and restores your model when done. Runtime overrides like `--cwd=<path>` and `--subagent=<name>` work too.

For more reusable workflows on top of subagents, including `/chain-prompts` and compare-style prompts such as `/best-of-n`, install `pi-prompt-template-model` separately and copy the examples you want into `~/.pi/agent/prompts/`.

## Runtime files

The main runtime files are:

| File | Purpose |
|------|---------|
| `src/extension/index.ts` | Extension registration, tool registration, message/render wiring. |
| `src/agents/agents.ts` | Agent and chain discovery, frontmatter parsing. |
| `src/runs/foreground/subagent-executor.ts` | Main execution routing for single, parallel, chain, management, status, interrupt, and doctor actions. |
| `src/runs/background/subagent-runner.ts` | Durable owner for single tasks, parallel groups, chains, and verification. |
| `src/runs/background/async-execution.ts` | Frozen launch configuration and detached owner startup for every mode. |
| `src/runs/shared/child-attempt.ts` | Shared process/event lifecycle for native Pi JSON CLI attempts and the Claude Code adapter. |
| `src/runs/foreground/wait-run.ts` | Abort-aware result/progress view over an owned run. |
| `src/runs/background/async-status.ts` | Durable and legacy run discovery and status formatting. |
| `src/runs/shared/run-records.ts` | Native parent ownership, saved launch/result recovery, attention-first lists, and lineage/review views. |
| `src/agents/chain-serializer.ts` / `src/runs/shared/chain-outputs.ts` / `src/runs/shared/dynamic-fanout.ts` | Saved chain parsing, named outputs, and bounded dynamic expansion. |
| `src/runs/shared/native-finalization.ts` | Same-process Pi self-review and current typed report submission. |
| `src/runs/shared/native-async.ts` / `src/runs/shared/parent-usage.ts` | Optional native pending-call binding and idempotent parent usage. |
| `src/shared/settings.ts` | Chain behavior, instructions, and config helpers. |
| `src/runs/shared/worktree.ts` | Git worktree isolation. |
| `src/intercom/intercom-bridge.ts` | Fixed intercom instructions, target names, and agent wiring. |
| `src/extension/schemas.ts` / `src/shared/types.ts` | Tool schemas, shared types, and event constants. |
| `test/unit/` / `test/integration/` | Unit and loader-based integration tests. |
