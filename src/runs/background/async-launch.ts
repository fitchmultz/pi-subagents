import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import type { ReadonlyDeep } from "type-fest";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../shared/pi-args.ts";
import {
  RUNNER_ERROR_LOG_FILE,
  RESULTS_DIR,
  SUBAGENT_ASYNC_STARTED_EVENT,
  type SubagentRunMode,
  type RunnerStep,
  type WorkflowGraphSnapshot,
  type NestedRouteInfo,
  type AsyncParallelGroupStatus,
} from "../../shared/types.ts";
import { formatRunAction } from "../../shared/status-format.ts";
import { ensureTempRoot } from "../../shared/temp-root.ts";
import { getRunMetadataDir } from "../shared/supervisor-questions.ts";
import {
  nestedResultsPath,
  resolveInheritedNestedRouteFromEnv,
  resolveNestedParentAddressFromEnv,
  writeNestedEvent,
} from "../shared/nested-events.ts";
import { resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import type {
  AsyncExecutionContext,
  AsyncExecutionResult,
  AsyncChainParams,
} from "./async-plan.ts";
import type { SubagentRunConfig } from "./runner-config.ts";

export function formatAsyncStartedMessage(
  headline: string,
  childSafe = process.env[SUBAGENT_CHILD_ENV] === "1" &&
    process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1",
): string {
  return [
    headline,
    "",
    "The async run is detached. Do not run sleep timers or polling loops just to wait for it.",
    "If you have independent work, continue that work. If you have nothing else to do until the async result arrives, end your turn now; Pi will deliver the completion when the run finishes.",
    `Use ${formatRunAction("status", "...", {}, childSafe)} when you need the current status/result, or to inspect a blocked/stale run. Do not poll just to wait.`,
  ].join("\n");
}

export function formatAsyncStartError(
  mode: SubagentRunMode,
  message: string,
): AsyncExecutionResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { mode, results: [] },
  };
}

export function launchErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : inspect(error);
}

export interface AsyncOwnerPreparation {
  readonly id: string;
  readonly asyncDir: string;
  readonly inheritedRoute: ReturnType<typeof resolveInheritedNestedRouteFromEnv>;
  readonly nestedAddress: ReturnType<typeof resolveNestedParentAddressFromEnv>;
}

export function prepareAsyncOwner(id: string): AsyncOwnerPreparation {
  const inheritedRoute = resolveInheritedNestedRouteFromEnv();
  const nestedAddress = inheritedRoute ? resolveNestedParentAddressFromEnv() : undefined;
  const asyncDir = getRunMetadataDir(id);
  fs.mkdirSync(asyncDir, { recursive: true });
  return { id, asyncDir, inheritedRoute, nestedAddress };
}

type LaunchOptions = Pick<
  AsyncChainParams,
  | "ctx"
  | "timeoutMs"
  | "maxOutput"
  | "artifactsDir"
  | "shareEnabled"
  | "sessionRoot"
  | "worktreeSetupHook"
  | "worktreeSetupHookTimeoutMs"
  | "controlConfig"
  | "controlIntercomTarget"
  | "nestedRoute"
  | "projectTrust"
>;

interface LaunchPlan {
  readonly steps: readonly RunnerStep[];
  readonly cwd: string;
  readonly resultMode: SubagentRunMode;
  readonly chainDir?: string;
  readonly originalTask?: string;
  readonly childIntercomTargets?: readonly (string | undefined)[];
  readonly dynamicFanoutMaxItems?: number;
  readonly workflowGraph?: WorkflowGraphSnapshot;
}

export function createRunnerLaunch(
  params: LaunchOptions,
  owner: AsyncOwnerPreparation,
  plan: LaunchPlan,
): SubagentRunConfig {
  const { inheritedRoute, nestedAddress, id } = owner;
  return {
    ...plan,
    id,
    timeoutMs: params.timeoutMs,
    resultPath: inheritedRoute
      ? nestedResultsPath(inheritedRoute.rootRunId, id)
      : path.join(RESULTS_DIR, `${id}.json`),
    placeholder: "{previous}",
    maxOutput: params.maxOutput,
    artifactsDir: params.artifactsDir,
    share: params.shareEnabled,
    sessionDir:
      params.sessionRoot === undefined || params.sessionRoot.length === 0
        ? undefined
        : path.join(params.sessionRoot, `async-${id}`),
    asyncDir: owner.asyncDir,
    sessionId: params.ctx.currentSessionId,
    rootSessionId: params.ctx.rootSessionId,
    piPackageRoot: resolvePiPackageRoot(),
    worktreeSetupHook: params.worktreeSetupHook,
    worktreeSetupHookTimeoutMs: params.worktreeSetupHookTimeoutMs,
    controlConfig: params.controlConfig,
    controlIntercomTarget: params.controlIntercomTarget,
    nestedRoute: params.nestedRoute ?? inheritedRoute,
    nestedSelf:
      inheritedRoute && nestedAddress
        ? {
            parentRunId: nestedAddress.parentRunId,
            parentStepIndex: nestedAddress.parentStepIndex,
            depth: nestedAddress.depth,
            path: nestedAddress.path,
          }
        : undefined,
    projectTrust: params.projectTrust,
  };
}

export type RunnerLaunchResult =
  | { readonly pid: number; readonly error?: never }
  | { readonly error: string; readonly pid?: never };

/** Handoff is irreversible once a pid exists; descriptor cleanup cannot turn it into a failed launch. */
export function spawnRunner(cfg: ReadonlyDeep<SubagentRunConfig>): RunnerLaunchResult {
  const { cwd, asyncDir } = cfg;
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return { error: `cwd is not a directory: ${cwd}` };
    }
  } catch {
    return { error: `cwd does not exist: ${cwd}` };
  }
  ensureTempRoot();
  const cfgPath = path.join(asyncDir, "launch.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, runtimeVersion: 2 }), {
    mode: 0o600,
    flag: "wx",
  });
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const fd = fs.openSync(path.join(asyncDir, RUNNER_ERROR_LOG_FILE), "a");
  try {
    const child = spawn(
      process.execPath,
      [
        path.join(directory, `subagent-runner-launcher${extension}`),
        path.join(directory, `subagent-runner${extension}`),
        cfgPath,
      ],
      { cwd, detached: true, stdio: ["ignore", "ignore", fd] },
    );
    child.on("error", (error) => {
      console.error(`[pi-subagents] async spawn failed: ${error.message}`);
    });
    if (typeof child.pid !== "number") {
      return { error: `async runner did not produce a pid for cwd: ${cwd}` };
    }
    try {
      child.unref();
    } catch (error) {
      console.error("[pi-subagents] async runner detach cleanup failed:", error);
    }
    return { pid: child.pid };
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      console.error("[pi-subagents] async runner stderr descriptor cleanup failed:", error);
    }
  }
}

export interface AsyncRunOverview {
  readonly agent?: string;
  readonly agents?: readonly string[];
  readonly task?: string;
  readonly chain?: readonly string[];
  readonly chainStepCount?: number;
  readonly parallelGroups?: readonly AsyncParallelGroupStatus[];
  readonly headline: string;
  readonly nestedRoute?: NestedRouteInfo;
}

function announceNestedStart(
  owner: AsyncOwnerPreparation,
  cfg: ReadonlyDeep<SubagentRunConfig>,
  pid: number,
  overview: AsyncRunOverview,
): void {
  const { inheritedRoute, nestedAddress } = owner;
  if (!inheritedRoute || !nestedAddress) {
    return;
  }
  const now = Date.now();
  try {
    writeNestedEvent(inheritedRoute, {
      type: "subagent.nested.started",
      ts: now,
      parentRunId: nestedAddress.parentRunId,
      parentStepIndex: nestedAddress.parentStepIndex,
      child: {
        id: cfg.id,
        parentRunId: nestedAddress.parentRunId,
        parentStepIndex: nestedAddress.parentStepIndex,
        depth: nestedAddress.depth,
        path: nestedAddress.path,
        asyncDir: cfg.asyncDir,
        pid,
        ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
        leafIntercomTarget: cfg.childIntercomTargets?.at(0) ?? undefined,
        intercomTarget: cfg.childIntercomTargets?.at(0) ?? undefined,
        ownerState: "live",
        mode: cfg.resultMode ?? "single",
        state: "running",
        agent: overview.agent,
        agents: overview.agents ?? (overview.agent === undefined ? [] : [overview.agent]),
        chainStepCount: overview.chainStepCount ?? 1,
        parallelGroups: overview.parallelGroups,
        startedAt: now,
        lastUpdate: now,
      },
    });
  } catch (error) {
    console.error("Failed to emit nested async start event:", error);
  }
}

export function launchAsyncRun(
  pi: AsyncExecutionContext["pi"],
  owner: AsyncOwnerPreparation,
  cfg: ReadonlyDeep<SubagentRunConfig>,
  overview: AsyncRunOverview,
): AsyncExecutionResult {
  const mode = cfg.resultMode ?? "single";
  let launched: RunnerLaunchResult;
  try {
    launched = spawnRunner(cfg);
  } catch (error) {
    return formatAsyncStartError(
      mode,
      `Failed to start async ${mode} '${cfg.id}': ${launchErrorMessage(error)}`,
    );
  }
  if (launched.error !== undefined) {
    return formatAsyncStartError(
      mode,
      `Failed to start async ${mode} '${cfg.id}': ${launched.error}`,
    );
  }
  announceNestedStart(owner, cfg, launched.pid, overview);
  let notice = "";
  const { headline, ...eventOverview } = overview;
  try {
    pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
      ...eventOverview,
      id: cfg.id,
      pid: launched.pid,
      sessionId: cfg.sessionId,
      mode,
      workflowGraph: cfg.workflowGraph,
      cwd: cfg.cwd,
      asyncDir: cfg.asyncDir,
      nestedRoute: overview.nestedRoute,
    });
  } catch (error) {
    // A detached process already owns this run. Returning isError would invite duplicate revival.
    notice = `\n\nRun started, but its tracking notice could not be published: ${launchErrorMessage(error)}`;
  }
  return {
    content: [{ type: "text", text: `${formatAsyncStartedMessage(headline)}${notice}` }],
    details: {
      mode,
      runId: cfg.id,
      results: [],
      asyncId: cfg.id,
      asyncDir: cfg.asyncDir,
      asyncPid: launched.pid,
      ...(cfg.workflowGraph ? { workflowGraph: cfg.workflowGraph } : {}),
    },
  };
}
