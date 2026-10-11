import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAsyncResumeTarget } from "../background/async-resume.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { resolveNestedAsyncDir } from "../shared/nested-events.ts";
import { readStatus } from "../../shared/utils.ts";
import type {
  ReadonlySubagentState,
  ReadonlyForegroundResumeRun,
  ReadonlyInput,
  NestedRunSummary,
  ResolvedAcceptanceConfig,
} from "../../shared/types.ts";
import { resolveRememberedForegroundRun } from "./foreground-memory.ts";
import type { SubagentParamsLike } from "./subagent-params.ts";
import type { NestedTarget } from "./nested-control.ts";

type AsyncTarget = ReadonlyInput<ReturnType<typeof resolveAsyncResumeTarget>> &
  ({ readonly kind: "live" } | { readonly kind: "revive" }) & { readonly source: "async" };
interface SavedTarget {
  readonly kind: "revive";
  readonly source: "foreground" | "nested";
  readonly runId: string;
  readonly state: "complete" | "failed" | "blocked" | "paused";
  readonly agent: string;
  readonly index: number;
  readonly intercomTarget: string;
  readonly cwd?: string;
  readonly sessionFile: string;
  readonly effectiveAcceptance?: ResolvedAcceptanceConfig;
}
export type ResumeSourceTarget = AsyncTarget | SavedTarget;
function foregroundTarget(
  params: SubagentParamsLike,
  state: ReadonlySubagentState,
): SavedTarget | undefined {
  const requested = (params.id ?? params.runId)?.trim();
  const run = resolveRememberedForegroundRun(requested, state);
  if (!run) {
    return;
  }
  if (run.children.length > 1 && params.index === undefined) {
    throw new Error(
      `Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`,
    );
  }
  const index = params.index ?? 0;
  if (!Number.isInteger(index)) {
    throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
  }
  const child = index >= 0 ? run.children.at(index) : undefined;
  if (!child) {
    throw new Error(
      `Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`,
    );
  }
  const sessionFile = foregroundSessionFile(run.runId, index, child);
  return {
    kind: "revive",
    source: "foreground",
    runId: run.runId,
    state: "complete",
    agent: child.agent,
    index,
    intercomTarget: resolveSubagentIntercomTarget(run.runId, child.agent, index),
    cwd: run.cwd,
    sessionFile,
    effectiveAcceptance: child.effectiveAcceptance,
  };
}
function foregroundSessionFile(
  runId: string,
  index: number,
  child: ReadonlyForegroundResumeRun["children"][number],
): string {
  if (child.status === "detached") {
    throw new Error(
      `Foreground run '${runId}' child ${index} is detached for intercom coordination and cannot be revived safely from the remembered foreground state. Reply to the supervisor request first; after the child exits, start a fresh follow-up if needed.`,
    );
  }
  const file = child.sessionFile;
  if (file === undefined || file.length === 0) {
    throw new Error(
      `Foreground run '${runId}' child ${index} does not have a persisted session file to resume from.`,
    );
  }
  if (path.extname(file) !== ".jsonl") {
    throw new Error(
      `Foreground run '${runId}' child ${index} session file must be a .jsonl file: ${file}`,
    );
  }
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Foreground run '${runId}' child ${index} session file does not exist: ${file}`,
    );
  }
  return resolved;
}
interface Failure {
  readonly error: unknown;
  readonly rethrow: () => never;
}
type AsyncCandidate = { readonly target: AsyncTarget } | Failure;
type ForegroundCandidate = { readonly target: SavedTarget | undefined } | Failure;
function asyncCandidate(params: SubagentParamsLike): AsyncCandidate {
  try {
    const target = resolveAsyncResumeTarget(params);
    return {
      target:
        target.kind === "live"
          ? { ...target, kind: "live", source: "async" }
          : { ...target, kind: "revive", source: "async" },
    };
  } catch (error) {
    return {
      error,
      rethrow: () => {
        throw error;
      },
    };
  }
}
function foregroundCandidate(
  params: SubagentParamsLike,
  state: ReadonlySubagentState,
): ForegroundCandidate {
  try {
    return { target: foregroundTarget(params, state) };
  } catch (error) {
    return {
      error,
      rethrow: () => {
        throw error;
      },
    };
  }
}
function exactError(error: unknown, source: "async" | "foreground", requested: string): boolean {
  if (!(error instanceof Error) || requested.length === 0) {
    return false;
  }
  const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${source} run '${escaped}'`, "i").test(error.message);
}
function ambiguity(error: unknown): boolean {
  return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}
function preferCandidate(
  target: ResumeSourceTarget,
  failure: Failure | undefined,
  requested: string,
  source: "async" | "foreground",
): ResumeSourceTarget {
  if (
    failure &&
    (exactError(failure.error, source, requested) ||
      (ambiguity(failure.error) && target.runId !== requested))
  ) {
    failure.rethrow();
  }
  return target;
}
function chooseBoth(
  foreground: SavedTarget,
  asynchronous: AsyncTarget,
  requested: string,
): ResumeSourceTarget {
  if (foreground.runId === requested && asynchronous.runId !== requested) {
    return foreground;
  }
  if (asynchronous.runId === requested && foreground.runId !== requested) {
    return asynchronous;
  }
  throw new Error(
    `Resume id '${requested}' is ambiguous between foreground run '${foreground.runId}' and async run '${asynchronous.runId}'. Provide a full run id.`,
  );
}
function selectResumeCandidate(
  foreground: ForegroundCandidate,
  asynchronous: AsyncCandidate,
  requested: string,
): ResumeSourceTarget {
  const fg = "target" in foreground ? foreground.target : undefined;
  const async = "target" in asynchronous ? asynchronous.target : undefined;
  if (fg && async) {
    return chooseBoth(fg, async, requested);
  }
  if (fg) {
    return preferCandidate(
      fg,
      "error" in asynchronous ? asynchronous : undefined,
      requested,
      "async",
    );
  }
  if (async) {
    return preferCandidate(
      async,
      "error" in foreground ? foreground : undefined,
      requested,
      "foreground",
    );
  }
  return rethrowMissingCandidates(foreground, asynchronous);
}
function rethrowMissingCandidates(
  foreground: ForegroundCandidate,
  asynchronous: AsyncCandidate,
): never {
  if ("error" in foreground && Boolean(foreground.error)) {
    foreground.rethrow();
  }
  if ("error" in asynchronous && Boolean(asynchronous.error)) {
    asynchronous.rethrow();
  }
  throw new Error("Run not found. Provide id or runId.");
}
export function resolveResumeTarget(
  params: SubagentParamsLike,
  state: ReadonlySubagentState,
): ResumeSourceTarget {
  const requested = (params.id ?? params.runId)?.trim() ?? "";
  return selectResumeCandidate(
    foregroundCandidate(params, state),
    asyncCandidate(params),
    requested,
  );
}
function nestedSessionFile(run: ReadonlyInput<NestedRunSummary>): string | undefined {
  return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}
function pathWithin(base: string, candidate: string): boolean {
  const root = path.resolve(base),
    file = path.resolve(candidate);
  return file === root || file.startsWith(`${root}${path.sep}`);
}
function trustedSessionFile(
  run: ReadonlyInput<NestedRunSummary>,
  roots: readonly string[],
): string {
  const file = nestedSessionFile(run);
  if (file === undefined || file.length === 0) {
    throw new Error(
      `Nested run '${run.id}' does not have a persisted session file to resume from.`,
    );
  }
  if (path.extname(file) !== ".jsonl") {
    throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${file}`);
  }
  if (!path.isAbsolute(file)) {
    throw new Error(`Nested run '${run.id}' session file must be absolute: ${file}`);
  }
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Nested run '${run.id}' session file does not exist: ${file}`);
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Nested run '${run.id}' session file is not a regular file: ${file}`);
  }
  const real = fs.realpathSync(resolved);
  const trusted = roots.filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
  if (!trusted.some((root) => pathWithin(root, real))) {
    throw new Error(
      `Nested run '${run.id}' session file is outside trusted nested session roots: ${file}`,
    );
  }
  if (!real.split(path.sep).includes(run.id)) {
    throw new Error(
      `Nested run '${run.id}' session file is not under that nested run's session directory: ${file}`,
    );
  }
  return real;
}
function nestedState(run: ReadonlyInput<NestedRunSummary>): SavedTarget["state"] {
  if (
    run.state === "complete" ||
    run.state === "failed" ||
    run.state === "blocked" ||
    run.state === "paused"
  ) {
    return run.state;
  }
  return "failed";
}
function nestedAgent(run: ReadonlyInput<NestedRunSummary>): string {
  const agent =
    run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined);
  if (agent === undefined || agent.length === 0) {
    throw new Error(`Could not determine child agent for nested run '${run.id}'.`);
  }
  return agent;
}
function nestedRuntimeDetails(
  dir: string | undefined,
): Pick<SavedTarget, "cwd" | "effectiveAcceptance"> {
  if (dir === undefined || dir.length === 0) {
    return {};
  }
  return {
    cwd: path.dirname(dir),
    effectiveAcceptance: readStatus(dir)?.steps?.[0]?.acceptance?.effectiveAcceptance,
  };
}
export function resolveNestedResumeTarget(
  target: NestedTarget,
  trustedRoots: readonly string[],
): SavedTarget {
  const run = target.match.run;
  if (run.state === "running" || run.state === "queued") {
    throw new Error(
      `Nested run '${run.id}' is live; route the follow-up to the owner process instead.`,
    );
  }
  const agent = nestedAgent(run);
  const dir = resolveNestedAsyncDir(target.match.rootRunId, run);
  const runtime = nestedRuntimeDetails(dir);
  return {
    kind: "revive",
    source: "nested",
    runId: run.id,
    state: nestedState(run),
    agent,
    index: 0,
    intercomTarget: resolveSubagentIntercomTarget(run.id, agent, 0),
    sessionFile: trustedSessionFile(run, trustedRoots),
    ...runtime,
  };
}
