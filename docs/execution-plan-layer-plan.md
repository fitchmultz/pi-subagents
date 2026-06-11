# ExecutionPlan layer refactor plan

## Status

Planning only. This is not approval for a broad rewrite. The goal is to move request normalization and per-child execution metadata out of large routers in small, reversible slices while preserving public behavior.

## Problem

`src/runs/foreground/subagent-executor.ts` currently mixes at least five responsibilities:

1. management actions: list/get/create/update/delete/status/resume/interrupt/doctor;
2. request normalization: action/mode detection, cwd resolution, context/fork policy, output behavior, max output, control config;
3. agent preparation: discovery, scope precedence, skills, model/fallback, resource limits, intercom bridge injection;
4. execution dispatch: foreground single/parallel/chain, async single/chain, clarify, worktree setup, nested routing;
5. result projection: foreground memory, status summaries, intercom receipts, output truncation, async-start messages.

Async launch code in `src/runs/background/async-execution.ts` and runner code in `src/runs/background/subagent-runner.ts` rebuild related metadata in parallel. That creates drift risk: a foreground fix to context policy, output behavior, resource limits, intercom bridge routing, worktrees, or acceptance can require a separate async serialization/runner fix.

An `ExecutionPlan` layer should not run children. It should be a pure, serializable description of *what should be run* after all request defaults and per-child metadata are resolved.

## Non-goals

- Do not change the public `subagent` tool schema or result shape while extracting the plan layer.
- Do not change default context policy, fork behavior, child tool exposure, project trust, intercom bridge defaults, nested-depth limits, or output defaults.
- Do not collapse foreground and async execution into one dispatcher.
- Do not move management/status/resume/interrupt actions into the execution plan.
- Do not add GitHub Actions or remote CI workflows.
- Do not create compatibility shims without a documented removal point.

## Inventory of preparation logic

| Concern | Current foreground owner | Async/runner counterpart | Plan ownership target |
|---|---|---|---|
| Raw tool params normalization | `normalizeSubagentParamsLike()` and `execute()` routing | async config files contain already-shaped values | Keep in request parser, before plan. |
| Mode selection | `execute()` plus `runSinglePath` / `runParallelPath` / `runChainPath` / `runAsyncPath` | `executeAsyncSingle()` / `executeAsyncChain()` choose mode | Plan stores `mode`, but dispatch remains adapter-owned. |
| Agent scope/discovery | executor resolves scope and discovers agents before dispatch | async runner receives serialized agent configs | Plan should contain resolved agent configs or stable references plus package identity. |
| Per-agent context | `resolveAgentContext()` and fork context resolver | serialized context/session fields | Plan should store effective context per child. |
| Skills | `discoverAvailableSkills()` and prompt assembly inputs | runner receives resolved skill behavior | Plan should store resolved skill names/warnings and prompt inheritance flags. |
| Model/fallback/thinking | `resolveModelCandidate()` / fallback lists | runner builds candidates from serialized config | Plan should store ordered model candidates and effective thinking. |
| Output behavior | `normalizeSingleOutputOverride()`, `resolveSingleOutputPath()`, chain behavior resolution | runner resolves output files again for steps | Plan should store output path/mode and output behavior per child. |
| Acceptance | effective acceptance contract per run/step | runner receives acceptance config and finalizes | Plan should store effective acceptance input and explicitness. |
| Resource limits | agent config merged into run options | runner receives maxExecutionTimeMs/maxTokens | Plan should store per-child limits. |
| Intercom bridge | resolve/apply bridge and child targets per context | async result/status use targets | Plan should store whether each child gets bridge tools/instructions and target names. |
| Nested routing | inherited route, per-child event/control metadata | runner writes nested events/status | Plan should store route metadata per child, not perform IO. |
| Worktrees | foreground parallel setup and cwd conflict checks | async runner has separate worktree setup/cleanup | Plan should store requested isolation and planned child cwd; setup stays adapter-owned. |
| Project trust | `resolveConfiguredChildProjectTrustPolicy()` | runner receives project trust | Plan should store effective project trust policy. |
| Clarify UI | chain clarify edits raw chain before execution | no async equivalent except explicit async | Clarify should run before plan creation. |

## Minimal data shape

Start with a deliberately small set of pure types in `src/runs/shared/execution-plan.ts`.

```ts
export interface ExecutionPlan {
  id: string;
  mode: "single" | "parallel" | "chain";
  cwd: string;
  contextOverride?: "fresh" | "fork";
  maxOutput?: MaxOutputConfig;
  projectTrust?: ChildProjectTrustPolicy;
  controlConfig: ResolvedControlConfig;
  intercomBridge: PlannedIntercomBridge;
  children: PlannedChild[];
  chain?: PlannedChain;
  worktree?: PlannedWorktree;
}

export interface PlannedChild {
  flatIndex: number;
  agentName: string;
  agentConfig: AgentConfig;
  task: string;
  cwd: string;
  effectiveContext: "fresh" | "fork";
  session: PlannedSession;
  modelCandidates: string[];
  thinking?: string;
  skills?: string[];
  skillsWarning?: string;
  output?: PlannedOutput;
  acceptance?: AcceptanceInput;
  resources: {
    maxExecutionTimeMs?: number;
    maxTokens?: number;
    maxSubagentDepth: number;
  };
  intercom?: PlannedChildIntercom;
  nestedRoute?: NestedRouteInfo;
  completionGuard: boolean;
}
```

The first implementation does not need every field above. Add fields only when a slice migrates one current behavior. Avoid speculative shape growth.

## What remains mode-specific

- Foreground `timeoutMs` / `maxRuntimeMs` wall-clock budget and partial-result timeout handling.
- Async/background status files, pid tracking, result files, stale-run reconciliation, and resume metadata.
- TUI clarify and foreground progress rendering.
- Worktree setup/cleanup lifecycle.
- Chain dynamic fanout materialization after prior structured outputs exist.
- Intercom result delivery/receipts.
- Management actions and status/resume/interrupt routing.

## Refactor slices

### Slice 1: Extract request/action routing away from execution planning

Files:

- Add `src/runs/foreground/subagent-request-router.ts` or `src/runs/shared/subagent-request.ts`.
- Move action/mode detection and management-action early returns out of `subagent-executor.ts`.
- Keep runtime behavior identical.

Validation:

- `test/unit/index-child-registration.test.ts` for registered tool behavior.
- Status/resume/interrupt unit tests.
- `npm run ci`.

Risk: low. This is mostly pure branching and error text preservation.

### Slice 2: Extract cwd, maxOutput, output, and control normalization

Files:

- Add `src/runs/shared/execution-options.ts`.
- Move `resolveRequestedCwd`, max output defaults, output mode normalization inputs, and `resolveControlConfig()` assembly into a pure helper.

Validation:

- Single-output unit tests.
- Tool schema tests for `maxOutput` and flexible fields.
- Foreground timeout/status tests.

Risk: low-medium. Error wording and cwd relative resolution must be unchanged.

### Slice 3: Extract per-child agent resolution for single and top-level parallel

Files:

- Add `src/runs/shared/execution-plan.ts` with `PlannedChild` for single/parallel only.
- Add `src/runs/shared/plan-agents.ts` for agent lookup, model candidates, context policy, resource limits, max depth, and project trust.
- Use the plan in foreground single/parallel first; async serialization can still use existing code.

Validation:

- Agent scope/override unit tests.
- Fork context integration tests.
- Foreground single and parallel integration tests.

Risk: medium. Context policy and intercom bridge application are easy to drift.

### Slice 4: Add async launch serialization from the same single/parallel plan

Files:

- Update `src/runs/background/async-execution.ts` to accept a planned representation for async single/top-level parallel launches.
- Keep persisted async config file format stable unless a separate migration task approves changes.
- If the plan cannot be persisted directly, add an explicit `serializeExecutionPlanForAsync()` adapter.

Validation:

- Async execution integration tests.
- Async status/resume/stale-run/result-watcher unit tests.
- `npm run ci`.

Risk: high. Async config/result files are persisted contracts.

### Slice 5: Extend planning to sequential/static chain steps

Files:

- Add `PlannedChain` / `PlannedChainStep` only after single/parallel are stable.
- Keep dynamic fanout runtime materialization adapter-owned because it depends on prior structured outputs.
- Move chain step behavior resolution into pure plan helpers where possible.

Validation:

- Chain execution integration tests.
- Chain serializer and dynamic fanout unit tests.
- Saved chain slash command tests.

Risk: high. Chain behavior includes templates, named outputs, dynamic fanout, clarify edits, and output schema validation.

### Slice 6: Move intercom bridge planning behind an adapter boundary

Files:

- Add `src/runs/shared/plan-intercom.ts`.
- Compute per-child bridge enablement from effective context and bridge mode.
- Keep actual intercom send/receipt delivery outside the plan.

Validation:

- Intercom bridge unit tests.
- Fork-context execution tests.
- Result-intercom formatter tests.

Risk: medium-high. CL-0005 fixed per-child fork-only behavior; regression tests must stay pinned.

### Slice 7: Delete duplicate preflight only after both foreground and async use the plan

Files:

- Remove redundant agent/context/output/intercom preparation from `subagent-executor.ts`, `async-execution.ts`, and `subagent-runner.ts`.
- Keep a compatibility adapter for old async result/config files only if a persisted-format migration requires it.

Validation:

- Full `npm run ci`.
- `npm run smoke:real-pi` when real Pi package loading is touched.
- `npm run smoke:overrides` after agent/discovery changes.

Risk: medium. Cleanup can accidentally remove edge-case validation.

## Test strategy

Before each implementation slice, add or identify tests that prove the slice's behavior is unchanged.

Required coverage:

- agent scope precedence: packaged, user, project, and disabled builtins;
- per-agent context and explicit context override;
- fork-only intercom per child;
- maxSubagentDepth inheritance/tightening;
- output path/mode resolution;
- resource limits per agent;
- async config/result compatibility;
- chain saved config with plural `skills`;
- dynamic fanout materialization and collection;
- worktree cwd conflict detection;
- nested route metadata and status projection.

## Proposed follow-up implementation task specs

These are task specs, not created queue entries yet.

1. **Extract subagent request routing**
   - Scope: `src/runs/foreground/subagent-executor.ts`, new request router module, status/resume/interrupt tests.
   - Done: management/control actions route through a small helper; no execution behavior changes; `npm run ci` passes.

2. **Extract execution option normalization**
   - Scope: cwd, maxOutput, output, control, project trust pure helpers.
   - Done: foreground and async launch call the same pure option normalizer; tests cover relative cwd and output edge cases.

3. **Introduce single/parallel PlannedChild**
   - Scope: agent discovery, context, model candidates, skills, resources for single and top-level parallel.
   - Done: foreground single/parallel runs from `PlannedChild`; existing tests pass.

4. **Serialize single/parallel plans for async launch**
   - Scope: `async-execution.ts`, runner config shape adapter, async tests.
   - Done: async single/parallel use the same planned child metadata without persisted result drift.

5. **Plan chain steps after single/parallel is stable**
   - Scope: chain behavior resolution, saved-chain behavior, static chain steps.
   - Done: chain tests pass; dynamic fanout remains adapter-owned unless separately planned.

6. **Plan intercom bridge enablement per child**
   - Scope: bridge mode, context resolution, child target names.
   - Done: fork-only bridge tests prevent whole-invocation bridge regressions.

## Residual risks

- A plan object can become a new god type if it tries to model every runtime side effect. Keep it pure and minimal.
- Async config serialization is the most dangerous boundary. Avoid changing persisted formats in the same slice as behavior extraction.
- Chain dynamic fanout is runtime-dependent and should not be forced into a static plan too early.
- Worktree setup is lifecycle state, not metadata. The plan can request isolation, but adapters must own cleanup.
- The repo has no remote CI by design; local validation evidence must be explicit.

## Completion criteria for the ExecutionPlan epic

- `subagent-executor.ts` shrinks by moving pure request/plan construction out, not by hiding complexity behind vague wrappers.
- Foreground and async dispatch consume the same planned child metadata for single/parallel paths.
- Chain planning is introduced only after single/parallel are stable.
- Public schema, README contract, result/status wording, and persisted async result compatibility are unchanged unless approved by a dedicated task.
- `npm run ci`, `npm run smoke:overrides`, and relevant real Pi smoke commands pass for each implementation slice.
