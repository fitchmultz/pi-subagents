# Shared child-run engine extraction plan

## Status

Planning only. Do not extract foreground/background child execution in one broad refactor. The safe path is to add parity tests first, introduce small shared primitives, migrate one behavior at a time, and keep foreground and async result contracts unchanged at every step.

## Problem

Foreground execution in `src/runs/foreground/execution.ts` and async/background execution in `src/runs/background/subagent-runner.ts` both own the same lifecycle-sensitive work:

- build Pi child process arguments and environment;
- spawn the child Pi process;
- stream and parse JSONL/stdout/stderr;
- track messages, model, usage, tool events, mutation attempts, and partial output;
- enforce execution/token limits;
- interrupt, timeout, final-drain, and hard-kill children;
- write artifacts or output logs;
- format final success/failure/resource-limit results.

The duplication has already produced fixes that must be applied twice: final-drain handling, resource limits, model recovery, partial-output preservation, child JSON event projection, and process cleanup. The goal is not a new runtime behavior. The goal is one shared, tested child-process lifecycle kernel with foreground and async adapters around it.

## Non-goals

- Do not merge foreground orchestration and async runner orchestration into one giant module.
- Do not change public result shapes, status wording, persisted result files, or timeout semantics during extraction.
- Do not change `timeoutMs` / `maxRuntimeMs`; those remain foreground parent wall-clock budgets.
- Do not make async runs honor foreground timeout fields.
- Do not remove intercom detach, nested event routing, worktree cleanup, acceptance finalization, completion guard, or artifact behavior.
- Do not add GitHub Actions or remote CI workflows for this fork.

## Current responsibility map

| Responsibility | Foreground path | Async/background path | Notes |
|---|---|---|---|
| Pi arg/env construction | `runSingleAttempt()` calls `buildPiArgs()` with foreground options | `runSingleStep()` calls `buildPiArgs()` before `runPiStreaming()` | Shared enough to keep `buildPiArgs()` as the adapter boundary. |
| Spawn command resolution | `getPiSpawnCommand(args)` | `getPiSpawnCommand(args, { piPackageRoot, argv1 })` | Shared kernel must accept optional Pi package root/argv hints. |
| stdout JSON parsing | `processLine()` parses child JSONL, mutates `SingleResult` and `AgentProgress` | `processStdoutLine()` parses child JSONL, writes output log and emits child events | Same parser inputs, different observers/sinks. |
| stderr handling | buffers stderr, uses it as fallback error | streams stderr into output log and child event log | Kernel should expose stderr chunks and final stderr. |
| final assistant drain | `startFinalDrain()` sends SIGTERM/SIGKILL after terminal assistant stop | similar `startFinalDrain()` in `runPiStreaming()` | First extraction candidate after parity tests. |
| post-exit stdio guard | `attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 })` | same call | Already shared; keep as precedent. |
| foreground timeout | parent wall-clock `timeoutAt` / `timeoutMs`, returns exit 124 and partial output | not supported; async must ignore foreground timeout fields | Keep adapter-only, outside shared per-child resource kernel. |
| resource limits | `maxExecutionTimeMs`, `maxTokens`, `resourceLimitExceeded` on `SingleResult` | same resource fields in async result/status | Good candidate for shared limit controller. |
| control/attention progress | foreground `AgentProgress`, `ControlEvent`, `onUpdate` | async `status.json`, runner activity, result events | Share low-level child events; keep status/progress projection in adapters. |
| intercom detach | foreground can detach a live child and return `detached` | async has interrupt/status/resume, not foreground detach | Adapter-only. |
| nested event projection | foreground emits/projections through nested route state | async writes child events to `events.jsonl` and status sidecars | Share event normalization only after tests pin route metadata. |
| output artifacts | foreground JSONL artifacts and single-output capture | async output log files and result files | Keep sinks pluggable; do not force one artifact model. |

## Proposed shared boundary

Add a small shared module, tentatively `src/runs/shared/child-process-runner.ts`, that owns only the process lifecycle kernel.

### Input shape

```ts
interface ChildProcessRunInput {
  label: string;
  commandArgs: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  piPackageRoot?: string;
  piArgv1?: string;
  maxExecutionTimeMs?: number;
  maxTokens?: number;
  jsonlSink?: { writeLine(line: string): void | Promise<void>; close?(): void | Promise<void> };
  textSink?: { write(text: string): void | Promise<void> };
  childEventSink?: (event: NormalizedChildEvent) => void;
  interrupt?: AbortSignal;
  finalStopGraceMs?: number;
  finalHardKillMs?: number;
}
```

### Output shape

```ts
interface ChildProcessRunResult {
  exitCode: number | null;
  signal?: NodeJS.Signals;
  stderr: string;
  messages: Message[];
  rawStdoutLines: string[];
  usage: Usage;
  model?: string;
  assistantError?: string;
  finalOutput: string;
  observedMutationAttempt: boolean;
  resourceLimitExceeded?: ResourceLimitExceeded;
  interrupted?: boolean;
  durationMs: number;
}
```

### Event shape

Keep the normalized event small and internal:

```ts
type NormalizedChildEvent =
  | { type: "raw_stdout"; line: string }
  | { type: "raw_stderr"; line: string }
  | { type: "tool_start"; toolName?: string; args?: Record<string, unknown>; mutates: boolean }
  | { type: "tool_end"; toolName?: string }
  | { type: "message"; message: Message; text: string; assistant: boolean }
  | { type: "resource_limit"; limit: ResourceLimitExceeded }
  | { type: "final_drain_signal"; signal: "SIGTERM" | "SIGKILL" };
```

Adapters then project those events into foreground progress or async status/events without the kernel knowing about widgets, `status.json`, intercom receipts, acceptance, worktrees, or chain graphs.

## Required parity tests before extraction

Add tests before moving code. Each test should pass on both existing implementations or have an explicit documented difference.

1. **Terminal assistant drain parity**
   - Child emits final assistant stop, keeps stdio open, then exits after forced signal.
   - Foreground and async both preserve final output and treat clean terminal stop as success.

2. **Partial output on timeout/resource limit**
   - Foreground timeout preserves partial assistant output.
   - Foreground/async resource limits preserve partial output/resource-limit message and do not retry fallback models.

3. **Raw stdout fallback parity**
   - Non-JSON stdout lines become final output when no assistant message exists.
   - Async output log keeps the same lines.

4. **Assistant provider-error parity**
   - `message.errorMessage` becomes the effective error unless a later non-error final assistant message clears it.

5. **Tool mutation detection parity**
   - Mutating tool starts set `observedMutationAttempt` in both foreground and async, so completion guard behavior remains stable.

6. **stderr fallback parity**
   - Non-zero child exit with stderr but no structured error returns stderr as error.
   - Stderr after a successful final assistant stop does not incorrectly fail a forced final drain.

7. **Interrupt parity**
   - Interrupt sends SIGINT then SIGTERM fallback, records interrupted state, and does not retry fallback models.

8. **JSONL artifact/event parity**
   - Foreground JSONL artifact and async `events.jsonl` still contain child JSON events with the same route metadata after migration.

## Refactor slices

### Slice 1: Extract pure child event parsing helpers

Files:

- Add `src/runs/shared/child-event-parser.ts`.
- Update `src/runs/foreground/execution.ts` and `src/runs/background/subagent-runner.ts` to call it.
- Add unit tests for malformed JSON, assistant messages, tool start/end, tool result, usage, and raw stdout fallback.

Validation:

- `npm run test:unit -- child-event` or equivalent targeted unit tests.
- `npm run test:integration -- single-execution async-execution` if filtering is supported, otherwise `npm run test:integration`.
- `npm run ci` before commit.

Risk:

- Low. Parser can be introduced with no process lifecycle changes.

### Slice 2: Extract final-drain and child-signal controller

Files:

- Add `src/runs/shared/child-process-lifecycle.ts` or extend existing `post-exit-stdio-guard.ts` with final-drain helpers.
- Replace duplicate `FINAL_STOP_GRACE_MS`, `HARD_KILL_MS`, `startFinalDrain()`, and signal tracking in foreground/background.

Validation:

- Existing final-drain foreground/async integration tests.
- New parity tests for clean terminal stop, dirty terminal stop, and hard-kill fallback.

Risk:

- Medium. Signal timing is flaky if tests use too-tight budgets. Use explicit mock steps and enough timeout margin.

### Slice 3: Extract resource-limit controller

Files:

- Add `src/runs/shared/child-resource-limits.ts`.
- Share `maxExecutionTimeMs` and `maxTokens` trigger behavior, escalation timing, and `ResourceLimitExceeded` formatting.

Validation:

- Existing foreground and async maxExecutionTimeMs/maxTokens tests.
- Explicit no-fallback-on-resource-limit assertions.

Risk:

- Medium. Foreground parent timeout must stay outside this controller.

### Slice 4: Introduce child process runner behind one adapter first

Files:

- Add `src/runs/shared/child-process-runner.ts`.
- Migrate foreground `runSingleAttempt()` first while keeping result shaping in `execution.ts`.
- Keep async on old `runPiStreaming()` until foreground is stable.

Validation:

- Full `test/integration/single-execution.test.ts`.
- `npm run ci`.

Risk:

- Medium-high. Foreground progress/control events are rich; keep adapter-owned progress updates.

### Slice 5: Migrate async `runPiStreaming()` to shared runner

Files:

- Update `src/runs/background/subagent-runner.ts` to use `child-process-runner.ts`.
- Keep status/result serialization in the runner.
- Preserve async output log and `events.jsonl` as adapter sinks.

Validation:

- Full `test/integration/async-execution.test.ts`.
- Result watcher/status/resume targeted tests.
- `npm run ci`.

Risk:

- High. Async persisted file contracts and resume/status behavior are external contract. Do not combine with other refactors.

### Slice 6: Delete duplicate lifecycle code and tighten type boundaries

Files:

- Remove old foreground/background duplicate helper blocks.
- Move shared types out of file-local definitions only after both adapters use the shared runner.

Validation:

- `npm run typecheck`.
- `npm run ci`.
- `npm run smoke:real-pi` when touching real Pi loading behavior.

Risk:

- Medium. Cleanup is safe only after both paths have passed parity.

## Residual risks

- Child process timing is inherently flaky. Tests need generous margins and deterministic mock output matching.
- Foreground control/attention state is richer than async status. Sharing too much would create a new god module.
- Async result files are a public recovery contract. Any migration must preserve result decoder compatibility.
- Intercom detach is foreground-only and should remain adapter-owned.
- Worktree cleanup belongs to orchestration, not the child-process kernel.

## Completion criteria for the extraction epic

- Foreground and async integration suites pass before and after every slice.
- `npm run ci` passes after every slice.
- No `.github/workflows` are added for this fork.
- New shared modules are smaller than the duplicated blocks they replace.
- Public README/schema/result/status behavior is unchanged unless a separate task approves a contract change.
