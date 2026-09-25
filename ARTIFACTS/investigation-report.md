# pi-subagents cached-input investigation

**Scope:** https://github.com/fitchmultz/pi-subagents (checkout `main` @ `29903ad`)  
**Mode:** investigation only. No code change. No user session logs, provider invoices, or live Pi processes were available.  
**Symptom under test:** ~4.26B cached input tokens / day vs ~11.2M output (~97% cache hit), model GPT-5/6 Astra, ~500k context, many agents running. Core Pi and pi-posthorse investigated separately.

**Verdict:** There is no proven unbounded spawn loop or API double-billing bug in this extension that would invent 4.26B cached tokens. The architecture **can** produce that magnitude as **real provider cache-read traffic** when a 500k parent plus N child sessions each resend a large stable prefix every tool turn. The unique multipliers are fork-cloned parent history, async overlap of parent+children, fan-out, and uncapped chain parallel size. Oracle is the only bundled role that forks by default.

| Claim | Confidence |
|---|---|
| Spawn / context / API path described below matches this tree | **High** |
| Forked children send the full inherited provider prefix to the model | **High** (fixture asserts it) |
| Fresh children do **not** copy parent conversation history | **High** (code + tests) |
| 4.26B cache-read is arithmetically reachable at 500k × N × T | **High** |
| This extension was the user’s actual 4.26B source | **Medium** (no invoices/session journals) |
| Unbounded recursive spawn exists in default config | **Ruled out** |
| `recordUsage` fabricates provider cache-read | **Ruled out** |

---

## 1. Architecture: spawn → context → API → usage

```text
Parent Pi session (GPT-5/6 Astra, up to ~500k)
  │  tool: subagent | delegate | agent_runs
  │  default: async (parent keeps its full session and can keep turning)
  ├─ resolve context per child: explicit context, else agent.defaultContext, else fresh
  ├─ fork? SessionManager.createBranchedSession(parentLeaf) → new *.jsonl
  │         copy of parent journal at fork time (not a summary)
  └─ fresh? new empty session.jsonl under <parentSessionStem>/<runId>/run-N/
        │
        ▼
  spawn `pi --mode json -p --session <child.jsonl> Task: ...`
        │  env: PI_SUBAGENT_CHILD=1, depth, inherit flags, intercom, fanout
        │  child is a full Pi coding-agent process with its own tool loop
        ▼
  each child tool turn: Pi assembles messages → provider API
        │  fork: inherited history (+ filter) + new task + skills/project files
        │  fresh: task + skills/project files, then grows by reads/tools
        ▼
  provider reports input / cacheRead / cacheWrite / output on each call
        ▼
  child journal → readNativeUsage (delta after launch baseline)
        ▼
  parent attribution via recordUsage (if host has it) or wait-tool result.usage
```

### 1.1 How a child is spawned

`createSubagentExecutor` is the only launch path (parent `index.ts` and nested `fanout-child.ts`). After validation it always goes through `runAsyncPath` → `executeAsyncSingle` / `executeAsyncChain` → `subagent-runner` → `runChildAttempt`.

The child process is a real `pi` CLI, not an in-process model call:

```40:48:src/runs/shared/child-attempt.ts
		const built = buildPiArgs({ ...input, structuredOutput: input.nativeFinalization ? undefined : input.structuredOutput, baseArgs: ["--mode", "json", "-p"] });
```

```145:150:src/runs/shared/child-attempt.ts
		const child = spawn(command.command, command.args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env, ...getSubagentDepthEnv(options.maxSubagentDepth) },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
```

`--mode json -p` still runs Pi’s normal assistant/tool loop until the child stops. **Each assistant step is a separate provider request** that resends the child’s current assembled context. That is the turn multiplier.

Session wiring:

```406:409:src/runs/foreground/subagent-executor.ts
		const childSessionFileForIndex = (idx?: number) =>
			sessionFileForIndex(idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");
		const childSessionFileForAgentIndex = (agentName: string | undefined, idx?: number) =>
			forkSessionFileForAgentIndex(agentName, idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");
```

```168:171:src/runs/shared/pi-args.ts
	if (input.sessionFile) {
		prepareChildExecutionCwd(input.sessionFile, input.cwd);
		fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
		args.push("--session", input.sessionFile);
```

README states the same contract: fork is a real session file, not a summary (`README.md` around the session-storage section).

### 1.2 Context inheritance (the critical split)

**Default is fresh**, unless the call or the agent says otherwise:

```22:24:src/shared/fork-context.ts
export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}
```

```29:39:src/shared/agent-context-policy.ts
export function resolveAgentContext(
	explicitContext: unknown,
	agentName: string | undefined,
	agents: readonly AgentConfig[],
): SubagentExecutionContext {
	if (explicitContext !== undefined) {
		return resolveSubagentContext(explicitContext);
	}
	if (!agentName) return "fresh";
	const agent = agents.find((entry) => entry.name === agentName);
	return agent?.defaultContext === "fork" ? "fork" : "fresh";
}
```

Explicit `context: "fork"` or `"fresh"` overrides **every** child in that call. When omitted, each child uses its own `defaultContext`.

#### Fresh children

`createForkContextResolver(..., "fresh")` never calls `createBranchedSession` and returns `undefined` (`test/unit/fork-context.test.ts`). The child gets a new `session.jsonl`. It does **not** receive parent conversation history.

Fresh children still inherit **environment**, not transcript:

| Knob | Bundled default | Effect |
|---|---|---|
| `systemPromptMode: append` | yes | Agent body is appended to Pi’s base prompt |
| `inheritProjectContext: true` | yes | `AGENTS.md` / `CLAUDE.md` etc. loaded unless `--no-context-files` |
| `inheritSkills: true` | yes | Discovered skills catalog unless `--no-skills` |
| Intercom bridge | always on | Extra system-section instructions + `contact_supervisor` |
| `pi-subagents` skill | stripped | Children do not get the parent orchestration skill |

`--no-skills` / `--no-context-files` are only passed when those flags are false (`src/runs/shared/pi-args.ts`). Inheritance flags **do not scrub already-copied fork history** (fixture below).

This can be tens of thousands of tokens. It is **not** a 500k parent transcript. **Confidence: high.**

#### Forked children — full parent copy

Fork opens the parent journal and asks Pi core for a branched session **per child index**:

```54:62:src/shared/fork-context.ts
		sessionFileForIndex(index = 0): string | undefined {
			const cached = cachedSessionFiles.get(index);
			if (cached) return cached;
			try {
				if (!fs.existsSync(parentSessionFile)) {
					throw new Error(`Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`);
				}
				const sourceManager = openSession(parentSessionFile, sessionDir);
				const sessionFile = sourceManager.createBranchedSession(leafId);
```

- Each parallel/chain index gets its **own** branched file (memoized per index). Proven in `test/unit/fork-context.test.ts` (“isolated branched sessions per index”).
- Child file is **not** the parent file (same test: `assert.notEqual(childSessionFile, parentSessionFile)`).
- Failure does **not** silently fall back to fresh.

The child process then runs `--session <forked-file>`, so its first model call includes the inherited transcript.

**Proof the provider payload includes the parent prefix** (`test/fixtures/native-prompt-sections.mjs`):

```97:110:test/fixtures/native-prompt-sections.mjs
test("unchanged-history forks preserve provider input prefix; fresh and disabled inheritance preserve selected text", async () => {
	// ...
	const forkFile = parent.sm.createBranchedSession(parent.sm.getLeafId());
	const baseline = await run(await make({ child: false, sessionFile: parentFile, profile: "PARENT PROFILE" }), "PARENT CONTINUATION");
	const fork = await run(await make({ sessionFile: forkFile }));
	const prefix = wire(baseline).slice(0, -1);
	assert.deepEqual(wire(fork).slice(0, prefix.length), prefix, "unchanged history must keep every inherited provider input item");
```

Same fixture: `inheritProjectContext: false` / `inheritSkills: false` **do not remove** `PROJECT POLICY` already present in forked history.

Forked tasks are wrapped so the child does not continue the parent chat (`wrapForkTask` + `DEFAULT_FORK_PREAMBLE` in `src/shared/types.ts`). That is a prompt wrapper only; it does not shrink inherited history.

#### Fork filtering (child-safety) vs cache

Child `context` hook strips parent-only orchestration artifacts **in the provider payload**, not in the saved journal:

```132:138:src/runs/shared/subagent-prompt-runtime.ts
	pi.on("context", (event) => {
		// Filtering changes the provider prefix, never the saved journal. Fanout children
		// need their own nested calls/results on later turns and resumes, so retain tool history.
		const messages = stripParentOnlySubagentMessages(event.messages, readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV) === true);
		if (messages === event.messages) return;
		return { messages };
	});
```

Stripped: custom types `subagent-orchestration-instructions`, slash/status/control notices, and (non-fanout) `subagent`/`delegate`/`agent_runs` tool calls **and** results.

The same fixture proves a filtered fork **does not** share the parent’s first provider item:

```139:140:test/fixtures/native-prompt-sections.mjs
	assert.doesNotMatch(JSON.stringify(wire(fork)), /inherited result|PARENT ONLY MESSAGE|call_subagent|call_delegate|call_agent_runs/);
	assert.notDeepEqual(wire(fork)[0], wire(parent)[0], "a filtered fork has a different provider prefix");
```

README already documents that filtered fork context does not guarantee cache-prefix reuse with the parent.

**Implication for 97% cache hit:**

- If the parent has little/no subagent tool history, fork and parent **share** a prefix → first child turn can cache-hit the parent’s 500k.
- If the parent has been orchestrating (likely), filtering **rewrites** the prefix → each forked child **cache-writes ~500k once**, then cache-hits **its own** prefix on later turns (~97% is expected).
- Filtering is deterministic, so it does **not** bust cache **every** child turn. **Confidence: high.**

Who forks by default in *this* tree:

| Bundled agent | `defaultContext` |
|---|---|
| `oracle` | `fork` (`agents/oracle.md`) |
| all other shipped roles (`worker`, `planner`, `reviewer*`, `scout`, …) | `fresh` |
| `delegate` | omitted → treated as fresh |

Older changelog text said planner/worker also defaulted to fork. **Current files do not.** User/project `subagents.agentOverrides` can put fork back. **Confidence: high for this repo; unknown for the user’s installed overrides.**

Oracle’s primary model is `openai-codex/gpt-6-astra` with fallback `openai/gpt-6-astra` — the same family as the symptom.

### 1.3 Parent keeps its full context while children run

Root registration:

```254:256:src/extension/index.ts
	const config = loadConfig();
	// Root calls default async; child-safe nested calls intentionally keep their stock foreground default.
	const asyncByDefault = config.asyncByDefault !== false;
```

Unless `async: false` or `asyncByDefault: false`, the parent tool returns a launch receipt and **continues its own 500k session**. Children are separate processes with separate journals. There is no code path that truncates the parent because children exist.

`forceTopLevelAsync: true` can force even `async: false` at depth 0 (`src/runs/background/top-level-async.ts`).

Foreground `async: false` waits; overlap is then children-only until completion, then the parent turns again.

**Answer to Q2: yes, parent keeps full context, and N children can each send large contexts every turn at the same time. Confidence: high.**

### 1.4 How results re-enter the parent

Several paths add tokens to the **parent** prefix (cache-read on later parent turns), not by mutating children:

1. **Async completion via Intercom** — one grouped message per run/result file, including **full child summaries** (`src/intercom/result-intercom.ts` `formatSubagentResultIntercomMessage`). Steer delivery injects at the next tool boundary (`deliverAs: "steer"` in `src/pi-intercom/index.ts`). Idle parent can be woken to consume completions.
2. **Foreground tool result** — compacted (raw message arrays stripped via `compactForegroundResult`), but still includes truncated output.
3. **Default `maxOutput`** is 200 KiB / 5000 lines (`DEFAULT_MAX_OUTPUT`). That is ~50k tokens **per child** if the parent inlines it. `outputMode: "file-only"` is opt-in.
4. **Control notices** inject into the parent transcript and **wake the model** (`triggerTurn: true` except async completion-guard):

```34:46:src/extension/control-notices.ts
	input.pi.sendMessage(
		{
			customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
			content: noticeText,
			display: true,
			details: { ...input.details, childIntercomTarget, noticeText },
		},
		{ triggerTurn: !(input.details.source === "async" && input.details.event.reason === "completion_guard") },
	);
```

Default attention threshold is 10 minutes idle (`DEFAULT_CONTROL_CONFIG`). Each notice can cost one full parent 500k turn.

5. **`contact_supervisor` / progress_update** — children are instructed to steer the supervisor. Busy parent: inject at next tool boundary (no extra turn by itself). Idle parent: inbound flush can trigger a turn. Watcher/oracle profiles encourage these pings.

Forked children **do not** receive later parent turns; they are snapshots. Re-injection balloons **parent** (and later forks from the new leaf), not the already-running child.

Chain `{previous}` / `{outputs.name}` copies prior child text into the **next** child’s task. File-only mode passes a pointer. Default inline can copy up to `maxOutput`.

**Answer to Q4: re-injection does not bust a child’s existing cache. It grows the parent suffix (uncached) and increases later parent (and future fork) cache-read size. Default inline summaries can be large. Confidence: high for mechanism, medium for how much of 4.26B this is.**

---

## 2. Fan-out, nesting, loops

### 2.1 One user action → many children (Q3)

Yes, several first-class shapes:

| Shape | Cap | Notes |
|---|---|---|
| `tasks: [...]` | `parallel.maxTasks` default **8** | Concurrent default **4** |
| `tasks[].count` | expanded then same max 8 | `normalizeRepeatedParallelCounts` |
| `/parallel-review` recipe | convention: ~3 reviewers | separate async singles; not enforced |
| `/review-loop` | convention: 3 rounds × ~3 reviewers + workers | parent-orchestrated; not enforced |
| Chain static `parallel` + `count` | **no maxTasks check** | concurrency 4; **count uncapped in code** |
| Dynamic fanout | `expand.maxItems` required | no nested dynamic fanout |

Top-level cap:

```66:68:src/runs/foreground/run-async-path.ts
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) {
			return buildParallelModeError(maxParallelTasksMessage(maxParallelTasks));
```

The chain branch of `runAsyncPath` never calls that check. `expandChainParallelCounts` repeats tasks for any integer `count >= 1` with no ceiling.

README: “Spawn-count and per-agent child-concurrency quotas are not part of this release.”

Skills tell the parent to launch **separate async singles** so each completion wakes the parent. That is **more parent 500k turns** than one aggregated `tasks` call.

**Answer to Q3: yes. Default 8-wide top-level, 4 concurrent. Chain parallel size is a control gap. Confidence: high.**

### 2.2 Nested / recursive spawn (Q5, Q7)

Depth env is set on every child:

```1193:1200:src/shared/types.ts
export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const childMaxDepth = normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth();
	const parentDepth = parseSubagentDepth(process.env.PI_SUBAGENT_DEPTH);
	const nextDepth = parentDepth === undefined ? childMaxDepth : parentDepth + 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(childMaxDepth),
	};
}
```

`checkSubagentDepth` blocks when `depth >= maxDepth`. Defaults:

- Installation `DEFAULT_SUBAGENT_MAX_DEPTH = 1` (parent may launch; first-level children may not).
- Bundled agent frontmatter `maxSubagentDepth: 0` and `allowSubagents: false`.
- Nested launch requires **both** global/inherited max ≥ 2 **and** the child profile to opt in.

Fanout-child still registers `subagent` only when `allowSubagents` or tools include `subagent`. Non-fanout children get boundary text: “Do not propose or run subagents.”

Loop guard (`src/runs/shared/subagent-tool-loop-guard.ts`) stops:

- 5× repeated `list`/`profiles` in a sliding window;
- 5× the **same failed** `subagent`/`delegate`/`agent_runs` args.

It does **not** stop successful launches of *different* tasks. There is no global spawn-rate limiter.

**Answer to Q5/Q7: default config cannot recurse. No code-level runaway spawn loop was found. Unbounded *sequential* parent launches over a day are allowed. Confidence: high.**

---

## 3. Usage accounting (Q6)

### 3.1 What the provider bills (the 4.26B class of number)

Billed cache-read is on **each HTTP request** from:

- the parent process, and
- every child `pi` process,

that share the API key. Prompt caching reports the stable prefix as `cacheRead` every turn. A 500k session doing a tool loop at 97% hit is working as designed, not a counter bug.

This extension does not implement provider caching. It only decides **which messages** each process sends.

### 3.2 What this extension records

`readNativeUsage` walks the **child** journal after a launch baseline:

- Counts new `usage` entries, compaction/branch_summary, assistant `message.usage`, toolResult `message.usage`.
- **Skips IDs present at launch** — inherited fork history’s *old* usage rows are not copied.
- Skips `checkpoint: true` copies.

Tests: `test/unit/native-usage.test.ts` (“excludes actual fork baseline … includes tool/summary/usage entries once”).

**Important:** excluding the baseline does **not** mean the child’s first API call is free. That call still sends inherited messages; the **new** assistant row’s `usage.cacheRead` is the 500k prefix. Accounting includes that. **Confidence: high.**

`registerParentUsage` then copies those contributions onto the parent (`kind: "subagent"`, id `subagent:<child-entry>`), idempotently. Official Pi 0.87.0 may lack `recordUsage`; then usage rides on the finalized wait/execution tool result only. Fire-and-forget async on portable hosts **does not** enter parent totals (`README.md` usage accounting).

`parseSessionTokens` (`src/shared/session-tokens.ts`) sums `input`/`output` only and **ignores `cacheRead`**. Status UI can under-report cache. It cannot create a 4.26B provider line item.

**Answer to Q6:** child API tokens are real and distinct from parent API tokens. Parent totals may **attribute** children (not bill them twice at the provider). Summing parent footer + OpenAI dashboard + child journals would double-count **in a spreadsheet**, not at OpenAI. **Confidence: high for code; medium that the user’s 4.26B is provider-side (the cache-hit wording matches provider metrics).**

---

## 4. Math: can N × turns × context hit 4.26B?

Provider cache-read ≈ (prefix tokens) × (requests that reuse that prefix).

```text
4.26e9 cache-read / 5.0e5 tokens  =  8520 full-window requests/day
11.2e6 output     / 8520          ≈  1300 output tokens/request
97% hit  ⇒  uncached input ≈ 4.26e9 × 0.03/0.97  ≈  1.3e8  (~15k new tokens/request)
```

Those ratios are **normal** for a tool-loop agent with a huge stable prefix and a small suffix (one tool result + short assistant text), not for a generation runaway.

| Scenario (all **High** as arithmetic; **unverified** as the user’s mix) | Cache-read / day |
|---|---|
| Parent only, 500k, 1 turn / 10s for 24h | ~4.3B |
| Parent + 1 forked oracle, both 500k, 1 turn / 20s | ~4.3B |
| 1 parent + 8 children at 500k, 1 turn / 2 min, 8h workday | ~1.1B |
| 1 parent + 8 children at 500k, 1 turn / 30s, 8h | ~4.3B |
| 8 **fresh** reviewers that never grow past 50k, 1 turn / 30s, 8h | ~0.43B |
| 20 separate async oracles/day, 40 turns each, forked 500k | 0.4B **plus** parent |

**What this means**

- 4.26B does **not** require a spawn loop. It requires **thousands of 500k-prefix requests**.
- “Many agents running” on Astra 500k with async default is sufficient **if** several sessions sit near the window and tool-loop.
- Fresh specialists that stay small cannot get to 4.26B without either filling toward 500k (workers reading a repo) **or** a large parent also turning hard.
- Forked oracle (or `context: "fork"` / overrides) is the only bundled way to start a child **already** at parent size.

**Assumption (marked):** average prefix is ~500k because the user stated 500k context. If they were at 250k, request count doubles for the same cache-read. If cache-read is billed per-request on the full prefix (OpenAI-style automatic caching), this model holds. **Confidence: high for OpenAI/Codex automatic caching behavior in general; this repo does not implement it.**

---

## 5. Proven bugs / control gaps (with citations)

None of these **invent** cache-read. They change how many large prefixes are sent.

### P1. Fork = full parent transcript on the wire — **by design, high cost at 500k**

Not a logic bug. Proven by `createBranchedSession` + native prompt fixture. Unique to this extension vs a single Pi session.

### P2. Oracle defaults to fork on Astra — **by design**

`agents/oracle.md`: `defaultContext: fork`, `model: openai-codex/gpt-6-astra`. README “good first prompts” push oracle first. Each call clones the live 500k parent, then tool-loops.

### P3. Async default ⇒ parent+children overlap — **by design**

`asyncByDefault !== false`. Parent 500k continues while N children also call the model.

### P4. Chain `parallel` / `count` is not covered by `maxTasks` — **control gap**

**Proven in code:** `maxParallelTasks` is only enforced for top-level `tasks`. Chain expansion has no ceiling. One chain step can materialize an arbitrary number of children (4 at a time). Combined with fork or large workers, this is the widest **single-call** fan-out.

Not proven to be what the user ran. Skills discourage huge panels.

### P5. No spawn-count quota, bundled agents have no `maxTokens` / `maxExecutionTimeMs`

Documented. Children can tool-loop until they exit. Watcher is designed to stay alive. Acceptance `maxFinalizationTurns` (example 3) adds extra same-session turns (each a full prefix resend).

### P6. Filtered fork **breaks parent-prefix cache sharing**

Proven by fixture `assert.notDeepEqual(wire(fork)[0], wire(parent)[0])`. First turn of a forked child after a busy orchestrating parent is typically a **cache write** of nearly the full window (expensive), then 97% hit. Does not explain 4.26B by itself; it explains why hit rate stays high **per child** after turn 1.

### P7. `parseSessionTokens` omits cache counters — **local reporting only**

Cannot produce provider 4.26B.

### P8. Control notices `triggerTurn: true`

Proven. Extra parent 500k turns on idle-attention, not a loop by itself (one notice per child/attention state).

---

## 6. Multipliers unique to this extension (vs core Pi alone)

Core Pi is **one** session resending one prefix. This package adds:

1. **N extra full Pi processes** per delegation, each with its own tool loop and cache prefix.
2. **Fork clone of parent history** (oracle / explicit `context: "fork"` / agentOverrides).
3. **Async overlap** of parent 500k + children.
4. **Fan-out recipes** (parallel review, review-loop, `count`, dynamic expand, chain parallel).
5. **Intercom steer + result summaries + attention wakes** adding parent turns and suffix tokens.
6. **Acceptance self-review** extra turns on the same child session.
7. **Model fallback** retries the same session on another model (cache typically **does not** transfer across models → another near-full uncached/cache-write pass).
8. **inheritSkills + inheritProjectContext** on every bundled child (system-prompt bulk, not 500k).
9. **No daily spawn cap.**

pi-posthorse is out of scope here; nothing in this tree depends on it for spawn/context.

---

## 7. Ruled-out hypotheses

| Hypothesis | Why ruled out | Confidence |
|---|---|---|
| Each child always gets a 500k parent copy | Only fork; fresh starts empty | **High** |
| Fresh default is secretly fork | `resolveSubagentContext` and tests | **High** |
| Fork failure falls back to parent session file | Throws; tests assert no silent fallback | **High** |
| Nested spawn storm on bundled profiles | `allowSubagents: false`, `maxSubagentDepth: 0`, global 1 | **High** |
| Identical-args spawn loop | Guard only for failed repeats/list; no success loop found | **High** |
| `recordUsage` double-bills OpenAI | Local journal attribution; provider sees child HTTP calls once | **High** |
| Compaction/toolResult journal rows double API traffic | Those rows record events that already happened; they do not issue extra HTTP calls | **High** |
| 97% hit implies a counter bug | Expected for stable prefixes | **High** |
| Output 11.2M vs 4.26B cache implies a generation bug | Ratio matches huge-prefix tool loops | **High** |
| This tree still defaults planner/worker to fork | Current `agents/*.md` are `fresh`; changelog is historical | **High** |
| User’s exact 4.26B came from chain `count` | Possible, not evidenced | **n/a** |

---

## 8. Fix recommendations (impact × invasiveness)

No patch in this PR: nothing here is a single accidental infinite loop. Ranked for **reducing billed cache-read**:

1. **Stop forking at 500k by default (highest impact).** Treat `defaultContext: fork` as a last resort. Change oracle to fresh **or** refuse fork when parent context tokens exceed a threshold. Pass explicit `context: "fresh"` in skills/prompts. User-side: `subagents.agentOverrides` → `oracle.defaultContext: fresh`. Fork only for short sessions.
2. **Cap chain parallel size with the same `maxTasks` as top-level `tasks`.** Close P4. Cheap, prevents one-call stampedes.
3. **Default `outputMode: "file-only"` (or much smaller `maxOutput`) for reviewers/scouts** so completions do not inflate the parent toward 500k. Already implemented as opt-in.
4. **Set bundled `maxTokens` / `maxExecutionTimeMs`** (README example 50k / 10 min). Bounds child tool loops that resend a growing prefix. `maxTokens` today is input+output of **assistant** usage, best-effort, and “billing also includes nested tools and summaries” (`child-attempt.ts`).
5. **Add a session spawn budget** (README already says it is missing): max live children, max launches per parent turn, max concurrent forked children (suggest 1).
6. **Do not wake the parent with `triggerTurn` for idle notices** when the parent is already at huge context; log to Agents view only. Completion delivery still needs a wakeup, but one grouped wakeup per wave is enough (partially already the case for grouped intercom).
7. **Prefer one `tasks` group over N separate async singles** when all results are required together — fewer parent 500k wakes. This **contradicts** current skill guidance (“separate singles so each completion wakes the parent”). At 500k, that guidance is a cost footgun.
8. **Disable `inheritSkills` for leaf roles** unless the task names a skill; keep project context if needed. Saves tens of k/turn, not billions, unless the skill catalog is huge.
9. **Instrument, don’t guess:** on child start log `context=fork|fresh`, session file, parent token estimate, and per-turn `usage.cacheRead`. Without that, 4.26B cannot be attributed to oracle vs parent vs workers.

**User-operational checks (no code):** inspect whether oracle/fork was used; how many concurrent child `pi` processes; whether parent session is actually ~500k; OpenAI grouping by `prompt_cache` vs uncached; whether `agentOverrides` restored planner/worker fork.

---

## 9. Direct answers to the seven questions

1. **Does each subagent get a full copy of the parent’s ~500k context?**  
   **Only if forked.** Fresh: no. Fork: yes, full journal copy on the wire. Oracle forks by default. **High.**

2. **Does the parent keep full context while N children also send large contexts every turn?**  
   **Yes** with async default (the default). **High.**

3. **Fan-out: can one user action spawn many parallel subagents each burning huge cached prefixes?**  
   **Yes.** Up to 8 top-level; chain parallel/`count` uncapped; 4 concurrent. Huge prefixes if those children are forked or have already filled context. **High.**

4. **Do results re-enter the parent in ways that bust or balloon cache?**  
   Balloon parent suffix (inline summaries, intercom, notices). Do not rewrite an in-flight child’s prefix. Later parent cache-read grows. Filtering can bust **parent↔child** prefix sharing on fork. **High** mechanism, **medium** magnitude.

5. **Nested subagents / recursive spawning?**  
   Default **no**. Custom `allowSubagents` + `maxSubagentDepth ≥ 2` **yes**, still bounded by inherited max. **High.**

6. **Usage accounting: child tokens attributed correctly or double-counted?**  
   Provider: one bill per HTTP call. Extension: attributes child deltas onto parent when the host API exists; excludes inherited journal rows; does not exclude inherited tokens on the child’s new calls. Spreadsheet double-count possible. **High.**

7. **Any runaway spawn loops?**  
   **No** in default runtime. Missing caps can allow **operator/parent-agent** stampedes. **High.**

---

## 10. What would confirm this on the user’s machine

Not done here (no journals/invoices). Highest-yield evidence:

1. Parent `*.jsonl` size / Pi `/ctx` at the time of the spike.
2. Child session files under the parent stem: fork vs `run-N/session.jsonl`; count of concurrent `--session` child processes.
3. Provider usage split by API key **and** by request metadata if any (parent vs child models: oracle Codex Astra vs workers).
4. `~/.pi/agent/extensions/subagent/config.json` (`asyncByDefault`, `maxSubagentDepth`, `forceTopLevelAsync`, `parallel.maxTasks`).
5. `subagents.agentOverrides` for `defaultContext: fork`.
6. Whether `/review-loop` or `count:` was used that day.
