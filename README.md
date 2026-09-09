# pi-subagents

`pi-subagents` lets Pi delegate work to focused child agents. Use it for code review, scouting, implementation, parallel audits, saved workflows, background jobs, and anything else that benefits from a second or third set of model eyes.

## Installation

Full durable-runtime support requires a corrected native [`fitchmultz/pi` build containing `952c27cd628ac742653f1fe4093685bdbe3a8444`](https://github.com/fitchmultz/pi/commit/952c27cd628ac742653f1fe4093685bdbe3a8444) ([native PR #16](https://github.com/fitchmultz/pi/pull/16)). It fixes prompt-admission ownership and settlement, including busy user startup, and includes the earlier custom steering/follow-up queue reporting, code-update restart notice, and `--session-cwd` support. Stock Pi 0.84.x and published 0.85.1 lack these contracts. The corrected fork also reports 0.85.1, so `pi --version` alone does not prove support. This package does not install the corrected native build.

With that native build available, install from GitHub:

```bash
pi install git:github.com/fitchmultz/pi-subagents
```

This package is not published to npm and does not provide an `npx` installer. Use `pi update --extension git:github.com/fitchmultz/pi-subagents` to refresh only this package. Before updating an in-use Pi checkout or extension, checkpoint work and **fully quit every Pi session using that installation**. Run rebuilds and updates from a separate terminal, then start fresh Pi processes. `/reload` can refresh supported settings, skills, and prompts, but cannot reliably activate changed JavaScript. Resume the **same saved parent session**, for example with `pi --session /path/to/parent.jsonl`, to retain run ownership, questions, and pending intercom delivery. A new or forked parent does not adopt them.

To restart the bundled broker too, close every Pi session using the same agent directory and wait at least five seconds before reopening Pi.

Local checkout installs remain available for development:

```bash
npm install   # builds dist/, which the pi manifest loads
pi install /absolute/path/to/pi-subagents
```

Local path installs do not run npm for you, and the manifest points at compiled `dist/` output, so run `npm install` (or `npm run build` after source edits) before installing or the extensions will not load.

Supported platforms: **macOS and Linux**. Termux on Android is unverified; Windows is not supported.

Pi core packages remain optional wildcard peers. Development dependencies are pinned to Pi 0.85.1 for compilation and package checks; those pins do not supply the native fixes above.

## Local validation

Use a built checkout of the required native Pi revision for the completion gate:

```bash
npm ci
export PI_INTERCOM_TEST_SDK=/absolute/path/to/pi/packages/coding-agent
export PI_OWNERSHIP_TEST_PACKAGE_ROOT="$PI_INTERCOM_TEST_SDK"
export PI_CONTEXT_TEST_PACKAGE_ROOT="$PI_INTERCOM_TEST_SDK"
export PI_PACKAGE_DIR="$PI_INTERCOM_TEST_SDK"
ln -sf "$PI_INTERCOM_TEST_SDK/dist/bundle/cli.js" node_modules/.bin/pi
npm run ci
```

All SDK overrides point at the built `packages/coding-agent` directory, not the monorepo root. The CLI link changes only this checkout's `node_modules/.bin/pi`; repeat it after `npm ci`, which restores the stock development CLI.

That command runs TypeScript no-emit checking, package shape smoke checks, an isolated single-package install smoke, and the full unit/integration suite. The bundled agent tests cover the Fitch profile set directly, so validation does not require pi-fitch-kit. `npm test` is intentionally the fast unit-test shortcut (`npm run test:unit`), not the full completion gate.

For a credential-free Linux gate against committed `HEAD`, Docker and `PI_LINUX_PI_ARCHIVE` are required. Supply an absolute path to a `.tar.gz` containing one top-level `pi/`: the required native checkout, its Linux `node_modules` (including workspace dependencies), and all built `dist/` output. It must include `pi/packages/coding-agent/dist/index.js` and `pi/packages/coding-agent/dist/bundle/cli.js`.

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
export PATH="$PWD/node_modules/.bin:$PATH" # corrected checkout-only CLI link from above
node scripts/real-pi-smoke.mjs
```

Use direct `node` invocation with the corrected `pi` first on `PATH`. npm scripts prepend `node_modules/.bin` and may select the stock development CLI if its link has not been changed after dependency installation.

It installs this checkout into an isolated temporary Pi home, runs `pi list`, and loads the bundled subagent and intercom extensions. It does not install pi-fitch-kit, publish to npm, or use GitHub Actions.

Live model-backed subagent paths are intentionally opt-in because they can use provider credentials and tokens:

```bash
PI_REAL_SMOKE_MODEL=openai/gpt-6-astra node scripts/real-pi-smoke.mjs --llm
```

That mode copies local `auth.json` and `models.json` into the isolated Pi agent dir, then asks a real Pi session to exercise intercom status plus subagent list, foreground, async launch, and async completion. Set `PI_REAL_SMOKE_AUTH_AGENT_DIR` if your auth files are not in `~/.pi/agent`.

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

For ordinary work, use the compact tools; the full workflow schema stays unloaded:

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

`delegate` uses the same execution and acceptance paths as `subagent`; `worktree: true` runs one isolated writer through the existing worktree path. `agent_runs` keeps the saved parent's work discoverable across working directories, reloads, and restarts. A nudge never restarts completed work; `continue` explicitly revives its saved session. Use `load_subagent` for parallel groups, chains, detailed overrides, and profile administration. Existing `subagent` calls remain supported.

### Owned runs, review, and continuation

`agent_runs({ action: "list" })` puts unanswered questions first, then failures, interrupted or unconfirmed work, live work, completed-but-unreviewed results, and other runs. It returns 20 runs by default. Use `offset` and `limit` (1–100) to page; `details.runList.nextOffset` points to the next page. Paging never discards history or disables exact-ID lookup. After the first read, unchanged finished runs reuse compact ordering facts instead of reloading every result and launch contract. Live or unconfirmed work, questions, and the displayed page stay fresh. `inspect` shows a concise task/result summary, acceptance outcome, questions, errors, paths, review, continuation links, and available live diagnostics. Use `full: true` for the full task and saved launch configuration (also supported by exact `subagent` status). Stored details and history are unchanged. Explicit continuation links identify separate work; a successor's result or review never satisfies the predecessor automatically.

`review` records `decision: "accepted"` or `"needs_changes"`, with an optional `message`. Review a finished result, not a live run. The decision is separate from execution status, runtime acceptance checks, and delivery. It returns a short saved-decision receipt, not another inspection. The review note is parent-only and is **not sent to the child**, including on revival. Put actionable instructions in `continue` or `nudge`. Review does not run checks, launch another child, or mark a follow-up accepted; inspect and late nudges do not restart anything.

Continuation and exited-question revival reuse the resolved provider/model, thinking level, profile, selected skill injection, tool/extension and context policies, output settings, limits, and acceptance contract. Changed profile defaults are not substituted. `agent_runs` accepts explicit `model`, `cwd`, `output`, and `acceptance` overrides on `continue`/`answer`; `agent` explicitly selects a current profile. Detailed overrides remain available through `subagent({ action: "resume", ... })`. Launch overrides apply when starting a continuation, not when delivering a follow-up or answer to a still-live child. In particular, live `continue`/`answer` acceptance overrides do **not** amend that child's acceptance contract. A missing worktree can be replaced with an explicit `cwd`; a missing child session cannot be invented. Every native saved-session launch, including acceptance finalization, passes its effective cwd through `--session-cwd` before extensions start, without rewriting the saved session header, identity, or history. If the same saved child already has a live continuation, another `continue` sends it the follow-up instead of starting a second process. Status labels distinguish **Launch cwd** from intercom's **Native session cwd**; neither proves a shell command's physical directory. The **Saved session header cwd** remains unchanged by the native override.

When the saved launch records that an output path was generated from a relative profile default, continuation and exited-question revival generate a new path for the successor using that saved filename, leaving the predecessor file untouched. Selecting a current profile with `agent` preserves the saved filename independently of that profile's current default; an explicit `output` override changes the output choice. Explicit paths, absolute profile defaults, and `output: false` retain their saved choices unless overridden. Older snapshots without output-origin information keep their saved paths; supply an explicit `output` override to choose a different path.

Old receipts recover their handles and available results from saved parent/child sessions and existing metadata. When an old run has no saved profile snapshot, continuation asks for an explicit `agent` choice rather than guessing its original configuration. Resuming the same saved parent restores its ownership; a new or forked parent does not automatically adopt that work. Explicit legacy async-ID inspection remains available without adopting the inspected run.

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

For ordinary delegation, Pi uses `delegate` and `agent_runs`. Parallel workflows and advanced controls use `load_subagent` to load the full orchestration schema on demand. Runs launch in the background by default, then notify the originating session on completion. Set `async: false` or use `--fg` when you explicitly need foreground streaming.

Installing the extension does not start an automatic reviewer in the background. It gives Pi a delegation tool. `acceptance.review` is not a supported shortcut: review remains parent-controlled so a worker cannot spend a full run and then fail for a reviewer result the runtime never produced. If you want every implementation reviewed, say that in your prompt or put it in your project instructions:

```text
When you finish implementing, run a reviewer subagent before summarizing.
```

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
| `watcher` | Read-only background monitoring with deferred, coalesced material-change updates to the parent. |
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

Use the narrowest role that fits the task. Keep implementation to one writer and launch reviewers separately. Every bundled profile sets `allowSubagents: false` and `maxSubagentDepth: 0`; the parent session owns all delegation.

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

Foreground runs stream progress in the conversation while they run. Set `async: false`, use `--fg`, enable `clarify: true`, or provide `timeoutMs`/`maxRuntimeMs` when a run must stay foreground. Use `timeoutMs` or its alias `maxRuntimeMs` when a foreground run must return within a wall-clock budget. While a foreground child is still active, `subagent({ action: "extend", id: "...", extendMs: 300000 })` can extend that timeout. When the timeout expires, running children are soft-interrupted, completed children stay in the result, and timed-out children return `timedOut: true` with a stable timeout message plus resume guidance when a child session was persisted. Foreground reviewer runs automatically raise short timeout budgets to at least 15 minutes. Planner/researcher-style roles raise short foreground budgets only when local run history shows they need longer.

Background runs are the default and keep working after control returns to you. Continue useful parent work while they run; if none remains, end the turn and wait for automatic completion delivery instead of polling. Use `subagent({ action: "status" })` only for diagnostics, or inspect a specific run with `subagent({ action: "status", id: "..." })`.

When a Codex-style Pi goal is active, set `async: false` for child evidence that must arrive before the next goal step. Ending the parent turn after launching async work can let goal prompting continue before the child evidence is available.

They also show a compact async widget and send completion notifications. Parallel background runs show per-agent progress instead of fake chain steps. Chains with parallel groups keep their grouped shape in progress and results, so failed or paused agents stay visible next to completed ones. Nested child delegation is disabled by default; keep fanout in the parent session.

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

The report identifies the running Node process, Pi's loaded version and reported resource directory, and the loaded extension build. Its SHA-256 fingerprint is embedded at build time from the emitted JavaScript, excluding the stamp itself; replacing files on disk does not change that loaded identity. Direct source loads report an unknown build. Pi's version and resource path alone do not prove the required native fork patches.

## Recommended orchestration pattern (scaffolding)

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → planner → worker → fresh reviewers → worker
```

Example prompt files for these patterns remain in `prompts/` for reference.

Packaged `oracle` defaults to forked context; the other Fitch role profiles default to fresh context. Forked context is rejected when an affected agent's effective primary or fallback model uses the `anthropic/` provider, and explicit context/model overrides cannot bypass that restriction.

Child-safety boundaries are enforced at runtime. Spawned child sessions do not receive the bundled `pi-subagents` skill, and forked child context filtering removes parent-only subagent artifacts (including old hidden orchestration-instruction messages, slash/status/control messages, and prior parent `subagent` tool-call/tool-result history) while preserving ordinary prose and unrelated tool calls/results. Children do not register the `subagent` tool by default and receive boundary instructions that they are not the parent orchestrator and must not propose or run subagents. The default depth limit allows parent-launched subagents but blocks those children from delegating again.

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

- `contact_supervisor`: the child contacts the parent/supervisor session that delegated the task. Use `reason: "need_decision"` only when the ephemeral child cannot safely continue and must remain alive for one steered supervisor reply. Use `reason: "interview_request"` only when it cannot safely continue until it receives multiple structured answers. Use `reason: "progress_update"` for concise material updates with intentionally deferred/coalesced delivery that may wait behind active supervisor work. Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

Child-side routine completion handoffs are still not expected. Parent-side `pi-subagents` sends grouped completion results through `pi-intercom`: one grouped message per foreground parent `subagent` run and one per completed async result file. Acknowledged foreground delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved. Grouped messages include child intercom targets, full child summaries, and compact nested child summaries under the parent child that launched them.

### Questions that survive a reload

Blocking supervisor questions are saved before notification, with their owner session, child session, and launch-time acceptance/output requirements. They do not expire at the ordinary intercom ask timeout. A foreground child detaches so the supervisor can answer; that is waiting for input, not successful completion.

```typescript
agent_runs({ action: "questions" })
agent_runs({ action: "answer", id: "<run-id>", questionId: "<question-id>", message: "Use the stable API." })
agent_runs({ action: "stop", id: "<run-id>" })
```

Resume the **same saved supervisor session**, even from another cwd, to recover its questions. A different session does not silently adopt them. Ordinary `intercom` replies also save the answer while the live waiter is connected. After supervisor/broker restart, prefer `agent_runs` questions/answer; a nudge is guidance, not an answer to a blocking question.

Answers are saved once. Repeating the same answer does not start duplicate work; conflicting answers are rejected without replacing the original. A live child reads the saved answer; an exited child resumes from its saved session in a new run, retaining the original acceptance contract. An answer receipt is not execution completion. `stop` cancels outstanding questions and aborts a live waiter even after the foreground registry was lost.

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

Slash commands run in the background by default. Add `--fg` only when the command must block. `--bg` explicitly requests background mode, which is useful when configuration sets `asyncByDefault` to `false`. `forceTopLevelAsync` overrides `--fg`, so disable it before requesting foreground execution:

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

Background runs are detached. Prefer separate single-agent runs for independent fanout so each completion wakes the parent instead of waiting for every child. The parent should continue useful work; if none remains, it should end the turn and wait instead of running sleep or status-polling loops. Pi will deliver each completion. When an active goal is incomplete and child evidence gates its next step, set `async: false`. Non-interactive one-shot Pi callers should also set `async: false` when stdout must contain the child result; omitted `async` returns only the launch receipt.

The `oracle` and `worker` builtins are designed for an explicit decision loop. A typical pattern is to ask `oracle` for diagnosis and a recommended execution prompt, then only run `worker` after the main agent approves that direction.

## Clarify and launch UI

Tool calls launch directly by default. Single, parallel, and chain runs can opt into the clarify UI with `clarify: true` when you want to preview or edit the workflow before it runs; slash commands launch directly.

Common clarify keys:

- `Enter` runs in the foreground, or in the background if background is toggled on
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

Subagents are designed to be narrow by default. Custom agents start with a clean system prompt and only the context you intentionally give them. They do not automatically inherit Pi’s whole base prompt, project instruction files, or discovered skills catalog.

Use these fields when an agent should see more:

| Field | Effect |
|-------|--------|
| `systemPromptMode: append` | Append the agent prompt to Pi’s normal base prompt. |
| `inheritProjectContext: true` | Keep inherited project instructions from files like `AGENTS.md` and `CLAUDE.md`. |
| `inheritSkills: true` | Let the child see Pi’s discovered skills catalog. |
| `defaultContext: fork` | Use forked session context when a launch omits `context`; explicit `context: "fresh"` still wins. |

Builtin agents opt into project instruction inheritance by default so they follow repo-specific rules out of the box. `delegate` also uses append mode because its job is orchestration inside the parent workflow.

Pi task arguments stay inline through 900 UTF-8 bytes, including the `Task: ` prefix; larger tasks use Pi's native `@file` input. System instructions use a separate temporary file, including for agents named `task`. This transport applies to foreground and background Pi runs; Claude Code transport is unchanged.

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
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
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
| `fallbackModels` | Ordered backup models for provider/model failures such as quota, usage limit, auth, timeout, or unavailable model. Foreground and async subagents first retry the same model once for recoverable transport failures such as WebSocket/stream/socket timeouts or SIGTERM-style provider exits, then fall back when appropriate. Ordinary task failures do not trigger retry or fallback. |
| `thinking` | Appended as a `:level` suffix at runtime unless a suffix is already present. |
| `systemPromptMode` | `replace` by default; `append` keeps Pi’s base prompt. |
| `inheritProjectContext` | Uses Pi's native context-file loading policy; `false` passes `--no-context-files`. |
| `inheritSkills` | Keeps or strips Pi’s discovered skills catalog. |
| `defaultContext` | Optional `fresh` or `fork` launch context default for this agent. |
| `skills` | Injects specific skills directly, regardless of `inheritSkills`. |
| `output` | Default single-agent output file. |
| `defaultReads` | Files to read before running in chain/parallel behavior. |
| `defaultProgress` | Maintain `progress.md`. |
| `completionGuard` | Opt in with `true` to require an observed successful mutating tool result. Disabled by default; task wording never determines success. An explicit `acceptance` contract takes precedence and can allow valid no-op outcomes. |
| `interactive` | Parsed for compatibility but not enforced in v1. |
| `maxSubagentDepth` | Tightens nested delegation for this agent’s children; use `0` to block delegation even if the tool is present. |
| `maxExecutionTimeMs` | Stops each foreground or async child run for this agent after the given number of milliseconds. |
| `maxTokens` | Stops each foreground or async child run for this agent when observed input plus output tokens reach the limit. Token enforcement is best-effort because usage is reported after model events arrive. |

### Tool and extension selection

All bundled agents omit `tools` and `extensions` allowlists. If `tools` is omitted, `pi-subagents` does not pass `--tools`, so the child keeps Pi’s configured builtin tools and tools from loaded extensions. If `tools` is present, regular tool names become an explicit allowlist. `mcp:` entries are split out and forwarded as direct MCP selections. Path-like `tools` entries, such as extension paths or `.ts`/`.js` files, are treated as tool-extension paths rather than builtin tool names. Tool capabilities and task prose do not imply a mutation requirement. Use `completionGuard: true` only when a successful mutating tool result is explicitly required, or use `acceptance` with real verification commands for stronger evidence.

Examples:

- `tools` omitted and `extensions` omitted: configured builtins and normal extensions, including their tools.
- `allowSubagents: true` with `tools` omitted: normal tools plus the child-safe `subagent` tool, but nested calls remain blocked unless the installation explicitly raises `maxSubagentDepth` above its default.
- `tools: mcp:chrome-devtools`: normal builtins plus direct Chrome DevTools MCP tools.
- `tools: read, bash, mcp:chrome-devtools`: only `read` and `bash` as builtins, plus direct Chrome DevTools MCP tools.
- `tools: subagent, read`: a child-safe `subagent` tool is available inside that child, but nested calls remain blocked unless the installation explicitly raises `maxSubagentDepth` above its default.

Direct MCP tools require [pi-mcp-adapter](https://github.com/fitchmultz/pi-mcp-adapter). By default, children preserve the adapter’s configured direct tools and any inherited `MCP_DIRECT_TOOLS` setting. Explicit `mcp:` entries override that selection; explicit `tools` and `extensions` allowlists still apply. The generic `mcp` and `mcp_script` tools remain available when enabled by the adapter and not excluded by an explicit allowlist. The adapter caches tool metadata at startup, so after connecting a new MCP server for the first time, restart Pi before relying on direct tools. An `mcp:` entry named `subagent` does not authorize nested fanout; explicit opt-in requires `allowSubagents: true` or the builtin `subagent` tool name plus a global depth limit above the default.

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

For chains, `skill` at the top level is additive. A step-level `skill` overrides that step; `false` disables skills for that step.

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
- **Safety boundaries**: child agents must not launch more subagents, must not invent intercom targets, and must escalate unapproved decisions
- **Intercom conventions**: when to ask vs send, and how parent-side result delivery works with `pi-intercom`
- **Control and diagnostics**: attention signals, soft interrupts, status, and the `doctor` action

If you are writing an agent that orchestrates subagents, the bundled skill helps it behave correctly without guessing the patterns. If you are a human user, you do not need to read it directly; the README and example prompts encode the same workflows in user-facing form.

## Programmatic tool usage

These are the parameters the LLM passes when it calls the `subagent` tool. Most users ask naturally or use slash commands instead.

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

// Foreground escape for same-turn evidence
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
| `timeoutMs` / `maxRuntimeMs` | number | - | Foreground wall-clock timeout for single, parallel, and chain runs. When `async` is omitted, either field implies foreground execution. Explicit async/background runs reject it. Short reviewer budgets are raised to a safe floor; planner/researcher-style budgets are raised only from local run-history duration data. For `action: "extend"`, `timeoutMs`/`maxRuntimeMs` can also supply the extension amount when `extendMs` is omitted. |
| `extendMs` | number | - | Additional milliseconds for `action: "extend"`. |
| `worktree` | boolean | false | Create isolated git worktrees for parallel tasks. |
| `chain` | array | - | Sequential, static parallel, and dynamic fanout chain steps. Sequential steps and parallel child tasks support `phase`, `label`, `as`, `outputSchema`, and `acceptance` in addition to the usual execution fields. Dynamic fanout uses `expand`, one child `parallel` template, and `collect`; group-level acceptance is not supported because there is no child session to finalize. |
| `context` | `fresh \| fork` | agent default or `fresh` | `fork` creates real branched sessions from the parent leaf. Packaged `oracle` defaults to `fork`; the other Fitch role profiles default to `fresh`. Fork is rejected for effective `anthropic/` primary or fallback models. |
| `chainDir` | string | temp chain dir | Persistent directory for chain artifacts. |
| `clarify` | boolean | false | Show TUI preview/edit flow only when explicitly set to `true`. |
| `agentScope` | `user \| project \| both` | `both` | Agent discovery scope. Project wins on collisions. |
| `async` | boolean | top-level: true | Background execution. Child-safe nested calls retain their foreground default so the result returns in the calling child's report. Set `false` for foreground execution; `clarify: true` and foreground timeout fields also keep the run foreground. |
| `cwd` | string | runtime cwd | Override working directory. |
| `progress` | boolean | agent default | Maintain `progress.md` for a single run. Parallel task-level progress is maintained in each task cwd; chain progress is maintained in `chainDir`. |
| `maxOutput` | object | 200KB, 5000 lines | Final output truncation limits. |
| `artifacts` | boolean | true | Write input, output, and metadata debug artifacts. JSONL is not written. |
| `includeProgress` | boolean | false | Include full progress in result. |
| `control` | object | enabled, 10-minute idle threshold | Override needs-attention tracking (`enabled`, `needsAttentionAfterMs`, `failedToolAttemptsBeforeAttention`, `notifyOn`, `notifyChannels`). |
| `share` | boolean | false | Upload session export to GitHub Gist. |
| `sessionDir` | string | derived | Override session log directory. |
| `acceptance` | object | omitted | Explicit criteria/evidence/verification contract. When present, the child gets a structured contract, then the runtime continues the same session for a bounded self-review/repair loop before evaluating acceptance. Launch independent reviewers separately from the parent. |

`context: "fork"` fails fast when an affected agent's effective primary or fallback model uses the `anthropic/` provider, the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created. The Anthropic restriction cannot be bypassed with explicit context or model overrides, and fork never silently downgrades to `fresh`. When a multi-agent run omits `context`, each child uses its own `defaultContext`: a fresh-default scout or reviewer stays fresh even when batched with fork-default `oracle`. Other providers continue to use these agent defaults and explicit context overrides normally.

By default, `output` paths are handoff files. Explicit `output` paths are resolved from the task cwd and left in place, so workspace paths like `.scratchpad/scout.md` remain readable after the run. Relative output paths that come only from an agent default are materialized under the run artifact directory as unique files, so parallel defaults like `context.md` or `review.md` do not collide and do not create project-root leftovers. In inline mode, the runtime reads the handoff content into the parent result and records `savedOutputPath`/`outputReference`; when a materialized agent-default file is consumed, the result records `outputCleanup`. Session artifacts still expose `artifactPaths.outputPath` when artifacts are enabled.

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

`status` resolves exact foreground ids, top-level async ids, and nested run ids before falling back to prefix matching. Completed, failed, and interrupted owned runs remain inspectable after reload or restart of the same saved parent. `id: "latest"` / `id: "last"` selects the latest owned run; exact IDs are retained regardless of list size. Nested status shows the root/parent path, nested children, session/artifact paths when known, and nested control commands. Inside child-safe fanout mode, bare `status` requires an id when no local foreground run is active, so children cannot enumerate unrelated top-level async runs. Bare `interrupt` still targets only the visible top-level run; interrupting a nested run requires its explicit nested id.

`extend` targets an active foreground run with an existing timeout and adds more milliseconds to the current child deadline. It is useful when progress or a needs-attention notice shows useful work still happening and throwing away the child session would waste context. It cannot revive an already-timed-out run; use `resume` after timeout.

`resume` sends the follow-up directly when a foreground or async child is still reachable over intercom. After completion, it revives the child by starting a new async child from the stored child session file. Multi-child async runs and remembered foreground single, parallel, or chain runs can be revived by passing `index` to choose the child. Nested runs can be resumed by nested id when their live route or persisted nested session metadata is available. Timed-out or transient-error foreground children also use this revive path when their `.jsonl` session file was persisted. Revived children reuse their saved effective launch configuration, including the original explicit acceptance contract. Explicit resume overrides replace the corresponding choices only on a newly launched continuation, never a live child's acceptance. `agent` opts into a current profile; old runs without a profile snapshot require that choice. Revive starts a new child process from the old session context; it does not restart the same OS process, and it requires the chosen child to have a persisted `.jsonl` session file.

`nudge` sends a short non-blocking steered intercom message to a live foreground or async child. Use it for guidance, answers, corrections, or blockers that may affect active work. The child treats it as supplemental coordination and continues its current task unless the message explicitly replaces it. It requires the bundled intercom extension and a registered child target. Use the `Ask:` command shown by `status` only when the parent must remain alive waiting for a reply.

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
- `node_modules/` is symlinked into each worktree when present
- task-level `cwd` overrides must be omitted or match the shared cwd
- configured `worktreeSetupHook` must return valid JSON before timeout

After a worktree parallel step completes, per-agent diff stats are appended to the output and full patch files are written to artifacts. Worktrees and temp branches are cleaned up in `finally` blocks.

## Configuration

`pi-subagents` reads optional JSON config from `~/.pi/agent/extensions/subagent/config.json`.

### `asyncByDefault`

Background execution is the stock top-level default. Restore the legacy foreground default if needed:

```json
{ "asyncByDefault": false }
```

The setting applies when a top-level tool or slash call does not explicitly set `async`. Child-safe nested calls retain their foreground default unless `asyncByDefault: true` is explicitly configured; set `async: false` when their result must appear in the calling child's report. Top-level callers can request foreground with `async: false` unless `forceTopLevelAsync` is enabled.

### `forceTopLevelAsync`

```json
{ "forceTopLevelAsync": true }
```

Forces depth-0 single, parallel, and chain runs into background mode and bypasses clarify UI by forcing `clarify: false`. Nested calls keep their own inherited settings.

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

### Agent resource limits

Set `maxExecutionTimeMs` and `maxTokens` in agent frontmatter or through `subagent({ action: "create" | "update", config })` to bound a specific agent across foreground and async runs.

```yaml
maxExecutionTimeMs: 600000
maxTokens: 50000
```

When a limit is reached, the child receives a soft interrupt, the run fails with a clear `Resource limit exceeded...` error, and the result includes `resourceLimitExceeded` with the limit kind, configured limit, and observed token count when available. Resource-limit failures do not trigger fallback model retries. `maxTokens` is best-effort because providers report usage after message events; a child may exceed the exact limit before the runtime can stop it.

Spawn-count and per-agent child-concurrency quotas are not part of this release; use `maxSubagentDepth` and parallel `concurrency` for those boundaries today.

### Intercom pairing

Intercom wiring is always on and bundled with `pi-subagents`. Children receive fixed default bridge instructions and parent-side result/control delivery uses the resolved orchestrator target automatically. If an agent sets an explicit `extensions` allowlist, include `pi-intercom` so child-side `intercom` and `contact_supervisor` tools stay available.

The injected guidance tells children to use steered blocking `contact_supervisor` decisions or structured interviews only when the ephemeral child cannot safely continue and must remain alive for the answer, intentionally deferred/coalesced `progress_update` for concise material updates, and generic intercom only as fallback plumbing. Supervisor nudges supplement the active task unless they explicitly replace it; routine completion still returns through normal child results.

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

Native parent `subagent-run` custom entries store ownership, continuation links, and parent review without adding them to model context. They are restored from the full saved session, not only its current context window. The existing per-run question/contract files and finalized result metadata live at `$PI_CODING_AGENT_DIR/sessions/subagent-runs/<run-id>/` (default `~/.pi/agent/sessions/subagent-runs/`): `question-owner.json`, `contracts/<index>.json`, `questions/`, and foreground or background result/status snapshots. Temporary-log cleanup does not remove these records. No separate task service or database is used.

The saved configuration retains profile choices and selected skill text, not copies of installed extensions or inherited project files. Those resources remain live. Debug artifacts and caller-owned output files can still be removed independently; inspection reports missing session/artifact paths, and a saved conversation alone never proves successful execution.

Async completions notify only the originating session. The result watcher emits `subagent:async-complete`, and the extension consumes that event to render completion notifications.

Async runs write:

```text
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/
  status.json
  events.jsonl
  output-<n>.log
  subagent-log-<id>.md
```

`status.json` powers the widget and `subagent({ action: "status" })` output. On `/reload` or when the originating Pi session is resumed, active runs for that session are rebuilt from these status files and return to the widget. `events.jsonl` contains wrapper events plus child Pi JSON events annotated with run and step metadata. Nested fanout status is stored as compact sidecar event/registry metadata and merged into parent status views and result/intercom payloads; full recursive status snapshots are not embedded in parent result files. `output-<n>.log` is a live human-readable tail. Fallback information is persisted so background runs are debuggable after completion.

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

When `acceptance` is present, the initial child prompt includes a standardized acceptance section and asks for a fenced `acceptance-report` JSON block. After the child’s initial completion, the runtime continues the same persisted child session with an acceptance finalization prompt. The child can repair omissions in that same session, then must return the final `acceptance-report`. Missing or malformed finalization reports reject the run when the loop limit is reached. The final answer replaces the initial answer and must stand alone with every requested handoff detail, including paths, identifiers, findings, and cumulative evidence—not only a statement that the work was rechecked.

Native Pi finalization submits the complete standalone answer, including its acceptance fence, through `structured_output({ value: { report: "..." } })`. After queued activity finishes, only the latest assistant turn's sole successful report submission is eligible; the saved capture must match that call. Further prompted activity requires resubmission, while passive context without a new model turn does not. Missing or stale submissions retry only within `maxFinalizationTurns`; an exhausted run is rejected with the prior full report retained as **UNCONFIRMED** audit evidence. The initial public `outputSchema` payload and Claude Code's finalization contract are unchanged.

Public acceptance config is evidence-driven. There is no public `level` field and no `acceptance: "checked"` shorthand. Runtime provenance is derived from what actually happened:

- `attested`: the child returned a structured acceptance report.
- `checked`: runtime structural checks passed, such as required criteria, required evidence, and no staged files.
- `verified`: configured runtime verification commands passed. Child-reported command success does not count.
- `rejected`: attestation, structural checks, verification, or finalization failed.

Independent review is not part of `acceptance`; the parent launches reviewer runs after the worker completes. Unsupported `acceptance.review` input fails during preflight before any child starts. Self-review finalization never counts as independent review, and it never counts as `verified` unless configured runtime verification commands actually pass. Child-written handoff files remain authoritative during finalization. Otherwise, the current finalization report supplies the parent result, chain input, and artifact output; native finalization also refreshes files generated from earlier assistant output. A report-only finalization keeps the prior handoff when no new summary is provided. The initial output remains available as acceptance audit evidence; finalization usage and residual risks are included in the result. Final reports describe cumulative whole-task evidence, including criterion-local evidence requirements, not only edits made during the finalization turn.

When delegating implementation from a plan or spec, keep the task focused on what to implement and put the definition of done in `acceptance` so the runtime can finalize and evaluate it:

```ts
subagent({
  agent: "worker",
  // Async is the default; set async: false only when this result must arrive in the same turn.
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

## Live progress

Foreground runs show compact live progress for single, chain, and parallel modes: current tool, recent output, token counts, duration, activity freshness, current-tool duration, and chain graph metadata when available.

Delegation receipts, completed responses, and completion messages show compact summaries by default. Press `Ctrl+O` to expand their full responses and details, or the full streaming view with output per step. The background async widget stays at one line per run until then. Collapsing these views does not shorten the content sent to the model.

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

Nested child delegation is disabled by default. The depth guard allows one level—main session → subagent—and blocks child subagents from launching more sessions. Keep fanout in the main parent session.

Configure the limit with:

1. `PI_SUBAGENT_MAX_DEPTH` before starting Pi
2. `config.maxSubagentDepth`
3. `maxSubagentDepth` in agent frontmatter, which can only tighten the inherited limit

```bash
export PI_SUBAGENT_MAX_DEPTH=1
```

`PI_SUBAGENT_DEPTH` is internal and propagated automatically. Do not set it manually; invalid values block nested subagents instead of resetting to zero.

## Events

Async events:

- `subagent:async-started`
- `subagent:async-complete`

Intercom delivery events:

- `subagent:control-intercom`
- `subagent:result-intercom`
- `subagent:live-intercom`
- `subagent:intercom-health-request`
- `subagent:supervisor-question-resolved` — `{ questionId }` after a durable answer or explicit cancellation; clears pending-ask presence without starting a turn.

The result watcher emits `subagent:async-complete`; `src/extension/index.ts` registers the notification handler that consumes it. Control/attention events are surfaced as visible parent notices and persisted for async runs. A terminal completion-guard notice stays visible and actionable but leaves the automatic parent wakeup to the matching completion result, avoiding two triggered turns. In async parallel groups that completion result arrives only after every sibling task finishes, so the automatic reaction to a mid-group guard notice is bounded by the longest-running sibling; the notice itself is still shown immediately. With `pi-intercom`, needs-attention notices, live nudges, best-effort child health, and grouped parent-side subagent result deliveries can reach the orchestrator over intercom.

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
| `src/runs/foreground/execution.ts` | Core foreground `runSync` handling. |
| `src/runs/background/subagent-runner.ts` | Detached async runner. |
| `src/runs/background/async-execution.ts` | Background launch support. |
| `src/runs/background/async-status.ts` | Status discovery and formatting for async runs. |
| `src/runs/shared/run-records.ts` | Native parent ownership, saved launch/result recovery, attention-first lists, and lineage/review views. |
| `src/runs/foreground/chain-execution.ts` / `src/agents/chain-serializer.ts` | Chain orchestration and `.chain.md` parsing. |
| `src/shared/settings.ts` | Chain behavior, instructions, and config helpers. |
| `src/runs/shared/worktree.ts` | Git worktree isolation. |
| `src/intercom/intercom-bridge.ts` | Fixed intercom instructions, target names, and agent wiring. |
| `src/extension/schemas.ts` / `src/shared/types.ts` | Tool schemas, shared types, and event constants. |
| `test/unit/` / `test/integration/` | Unit and loader-based integration tests. |
