import { spawn, spawnSync } from "node:child_process";
import { addAbortListener } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { ensureTempRoot } from "../../shared/temp-root.ts";
import { trySignalChildTree } from "../../shared/post-exit-stdio-guard.ts";

export class WorktreeCleanupError extends Error {}

export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
	preserveOnCleanup?: boolean;
	preservationReason?: string;
}

interface WorktreeInfo {
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	syntheticPaths: string[];
}

interface WorktreeDiff {
	index: number;
	agent: string;
	branch: string;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	patchPath: string;
	worktreePath?: string;
	captureError?: string;
}

interface WorktreeTaskCwdConflict {
	index: number;
	agent: string;
	cwd: string;
}

interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

interface CreateWorktreesOptions {
	agents?: string[];
	setupHook?: WorktreeSetupHookConfig;
	signal?: AbortSignal;
}

interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs: number;
}

interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

interface RepoState {
	toplevel: string;
	cwdRelative: string;
	baseCommit: string;
}

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

function runGitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function runSetupCommand(
	command: string, args: string[], cwd: string, signal?: AbortSignal, input?: string, timeoutMs?: number,
): Promise<GitResult> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let failure: Error | undefined;
		const child = spawn(command, args, { cwd, detached: true, stdio: "pipe" });
		const terminate = () => { trySignalChildTree(child, "SIGKILL"); };
		const abortListener = signal && addAbortListener(signal, terminate);
		const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
			failure = new Error(`worktree setup hook timed out after ${timeoutMs}ms`);
			terminate();
		}, timeoutMs);
		timer?.unref();
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				outputBytes += Buffer.byteLength(chunk);
				// Keep the previous spawnSync output bound.
				if (outputBytes > 1024 * 1024) {
					failure ??= new Error(`${command} output exceeded 1048576 bytes`);
					terminate();
				} else if (stream === child.stdout) stdout += chunk;
				else stderr += chunk;
			});
		}
		child.on("error", (error) => { failure = error; terminate(); });
		child.on("exit", (status) => { if (status !== 0) terminate(); });
		child.on("close", (status) => {
			clearTimeout(timer);
			abortListener?.[Symbol.dispose]();
			if (signal?.aborted) reject(signal.reason);
			else if (failure) reject(failure);
			else resolve({ stdout, stderr, status });
		});
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE") return; // The hook can exit without reading its payload.
			failure = error;
			terminate();
		});
		child.stdin.end(input);
	});
}

async function runSetupGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const result = await runSetupCommand("git", ["-C", cwd, ...args], cwd, signal);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git -C ${cwd} ${args.join(" ")} failed`);
	}
	return result.stdout;
}

async function resolveRepoState(cwd: string, signal?: AbortSignal): Promise<RepoState> {
	const repoCheck = await runSetupCommand("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], cwd, signal);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const cwdRelative = (await runSetupGit(cwd, ["rev-parse", "--show-prefix"], signal)).trim().replace(/[\\/]+$/, "");
	const toplevel = (await runSetupGit(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();

	const status = await runSetupGit(toplevel, ["status", "--porcelain"], signal);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first, or rerun without worktree isolation if shared-checkout edits are intentional.");
	}

	const baseCommit = (await runSetupGit(toplevel, ["rev-parse", "HEAD"], signal)).trim();
	return { toplevel, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	try {
		return fs.realpathSync(resolved);
	} catch {
		// Use the unresolved absolute path when realpath resolution is unavailable.
		return resolved;
	}
}

export function findWorktreeTaskCwdConflict(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): WorktreeTaskCwdConflict | undefined {
	const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		if (!task.cwd) continue;
		const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
		if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd) continue;
		return { index, agent: task.agent, cwd: task.cwd };
	}
	return undefined;
}

export function formatWorktreeTaskCwdConflict(
	conflict: WorktreeTaskCwdConflict,
	sharedCwd: string,
): string {
	return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}

function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function buildWorktreeBranch(runId: string, index: number): string {
	return `pi-parallel-${runId}-${index}`;
}

function buildWorktreePath(runId: string, index: number): string {
	return path.join(TEMP_ROOT_DIR, "worktrees", `pi-worktree-${runId}-${index}`);
}

function resolveRepoCwdRelative(cwd: string): string {
	const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
	const normalizedPrefix = rawPrefix
		? path.normalize(rawPrefix.replace(/[\\/]+$/, ""))
		: "";
	return normalizedPrefix === "." ? "" : normalizedPrefix;
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number): string {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const worktreePath = buildWorktreePath(runId, index);
	return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}

function parseHookTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("worktree setup hook timeout must be an integer greater than 0");
	}
	return timeoutMs;
}

function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
	if (!config) return undefined;
	const hookPath = config.hookPath.trim();
	if (!hookPath) {
		throw new Error("worktree setup hook path cannot be empty");
	}

	const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
	let resolvedPath: string;
	if (path.isAbsolute(expandedHookPath)) {
		resolvedPath = expandedHookPath;
	} else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
		resolvedPath = path.resolve(repoRoot, expandedHookPath);
	} else {
		throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
	}

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if (fs.statSync(resolvedPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
	}

	return {
		hookPath: resolvedPath,
		timeoutMs: parseHookTimeout(config.timeoutMs),
	};
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) throw new Error("synthetic path cannot be empty");
	if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);

	const resolved = path.resolve(worktreePath, trimmed);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === ".") {
		throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
	}
	return path.normalize(relative);
}

async function hasTrackedEntries(worktreePath: string, relativePath: string, signal?: AbortSignal): Promise<boolean> {
	const result = await runSetupCommand("git", ["-C", worktreePath, "ls-files", "--", relativePath], worktreePath, signal);
	return result.status === 0 && result.stdout.trim().length > 0;
}

function parseWorktreeSetupHookOutput(rawStdout: string): WorktreeSetupHookOutput {
	const trimmed = rawStdout.trim();
	if (!trimmed) {
		throw new Error("worktree setup hook returned empty stdout; expected JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`worktree setup hook returned invalid JSON: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("worktree setup hook stdout must be a JSON object");
	}
	return parsed as WorktreeSetupHookOutput;
}

async function runWorktreeSetupHook(
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
	signal?: AbortSignal,
): Promise<string[]> {
	let result: GitResult;
	try {
		result = await runSetupCommand(hook.hookPath, [], input.worktreePath, signal, JSON.stringify(input), hook.timeoutMs);
	} catch (error) {
		signal?.throwIfAborted();
		throw new Error(`worktree setup hook failed: ${getErrorMessage(error)}`);
	}

	if (result.status !== 0) {
		const details = result.stderr.trim() || result.stdout.trim() || "no output";
		throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
	}

	const output = parseWorktreeSetupHookOutput(result.stdout);
	if (output.syntheticPaths === undefined) return [];
	if (!Array.isArray(output.syntheticPaths)) {
		throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
	}

	const uniquePaths = new Set<string>();
	for (const candidate of output.syntheticPaths) {
		if (typeof candidate !== "string") {
			throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
		}
		const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
		if (await hasTrackedEntries(input.worktreePath, normalizedPath, signal)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
		}
		uniquePaths.add(normalizedPath);
	}
	return [...uniquePaths];
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return;
	}

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}

	const realRoot = fs.realpathSync(worktree.path);
	const realParent = fs.realpathSync(path.dirname(resolved));
	const parentRelative = path.relative(realRoot, realParent);
	if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
		throw new Error(`synthetic path resolves outside the worktree: ${syntheticPath}`);
	}

	if (stat.isSymbolicLink()) {
		fs.unlinkSync(resolved);
		return;
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved, { recursive: true, force: true });
		return;
	}
	fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath);
	}
}

function emptyDiff(index: number, agent: string, branch: string, patchPath: string, worktreePath?: string, captureError?: string): WorktreeDiff {
	return {
		index,
		agent,
		branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
		...(worktreePath ? { worktreePath } : {}),
		...(captureError ? { captureError } : {}),
	};
}

function parseNumstat(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
	const lines = numstat
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;

	for (const line of lines) {
		const [rawInsertions, rawDeletions] = line.split("\t");
		if (rawInsertions === undefined || rawDeletions === undefined) continue;
		filesChanged++;
		if (/^\d+$/.test(rawInsertions)) insertions += parseInt(rawInsertions, 10);
		if (/^\d+$/.test(rawDeletions)) deletions += parseInt(rawDeletions, 10);
	}

	return { filesChanged, insertions, deletions };
}

function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
): WorktreeDiff {
	removeSyntheticPathsBeforeDiff(worktree);
	runGitChecked(worktree.path, ["add", "-A"]);
	const diffStat = runGitChecked(worktree.path, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
	const patch = runGitChecked(worktree.path, ["diff", "--cached", "--binary", "--no-textconv", "--no-ext-diff", setup.baseCommit]);
	const numstat = runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
	fs.writeFileSync(patchPath, patch, "utf-8");

	if (!patch.trim()) {
		return emptyDiff(worktree.index, agent, worktree.branch, patchPath, worktree.path);
	}

	const parsed = parseNumstat(numstat);
	return {
		index: worktree.index,
		agent,
		branch: worktree.branch,
		diffStat,
		filesChanged: parsed.filesChanged,
		insertions: parsed.insertions,
		deletions: parsed.deletions,
		patchPath,
		worktreePath: worktree.path,
	};
}

function writeEmptyPatch(patchPath: string): void {
	try {
		fs.writeFileSync(patchPath, "", "utf-8");
	} catch {
		// Diff artifact writing is best-effort in error paths.
	}
}

function cleanupSingleWorktree(repoCwd: string, worktree: WorktreeInfo): void {
	try { runGitChecked(repoCwd, ["worktree", "remove", "--force", worktree.path]); } catch (error) {
		console.error(`Failed to remove worktree '${worktree.path}': ${getErrorMessage(error)}`);
	}
	try { runGitChecked(repoCwd, ["branch", "-D", worktree.branch]); } catch (error) {
		console.error(`Failed to delete worktree branch '${worktree.branch}': ${getErrorMessage(error)}`);
	}
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
	return Boolean(diff.captureError) || diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function markWorktreesForPreservation(setup: WorktreeSetup, reason: string): void {
	setup.preserveOnCleanup = true;
	setup.preservationReason = setup.preservationReason
		? `${setup.preservationReason}; ${reason}`
		: reason;
}

export async function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): Promise<WorktreeSetup> {
	const signal = options?.signal;
	const repo = await resolveRepoState(cwd, signal);
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	const worktrees: WorktreeInfo[] = [];
	const rollback: Array<{ path?: string; branch?: string }> = [];

	try {
		for (let index = 0; index < count; index++) {
			const branch = buildWorktreeBranch(runId, index);
			const worktreePath = buildWorktreePath(runId, index);
			ensureTempRoot();
			const pathExisted = fs.existsSync(worktreePath);
			const branchExisted = (await runSetupGit(repo.toplevel, ["branch", "--list", branch], signal)).trim().length > 0;
			rollback.push({ path: pathExisted ? undefined : worktreePath, branch: branchExisted ? undefined : branch });
			await runSetupGit(repo.toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"], signal);
			const agentCwd = repo.cwdRelative ? path.join(worktreePath, repo.cwdRelative) : worktreePath;
			const syntheticPaths = setupHook ? await runWorktreeSetupHook(setupHook, {
				version: 1, repoRoot: repo.toplevel, worktreePath, agentCwd, branch, index, runId,
				baseCommit: repo.baseCommit, agent: options?.agents?.[index],
			}, signal) : [];
			worktrees.push({ path: worktreePath, agentCwd, branch, index, syntheticPaths });
		}
	} catch (error) {
		// Rollback still runs after Stop, but its own Git hooks must not hang the owner.
		const cleanupSignal = AbortSignal.timeout(setupHook?.timeoutMs ?? DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS);
		const failures: string[] = [];
		for (const entry of rollback.reverse()) {
			if (entry.path && fs.existsSync(entry.path)) {
				try {
					// Interrupted checkout can leave Git's "initializing" lock on this new worktree.
					await runSetupGit(repo.toplevel, ["worktree", "remove", "--force", "--force", entry.path], cleanupSignal);
				} catch (cleanupError) { failures.push(`Could not remove worktree '${entry.path}': ${getErrorMessage(cleanupError)}`); }
			}
			if (entry.branch) {
				try {
					const exists = (await runSetupGit(repo.toplevel, ["branch", "--list", entry.branch], cleanupSignal)).trim();
					if (exists) await runSetupGit(repo.toplevel, ["branch", "-D", entry.branch], cleanupSignal);
				} catch (cleanupError) { failures.push(`Could not delete worktree branch '${entry.branch}': ${getErrorMessage(cleanupError)}`); }
			}
		}
		if (failures.length) throw new WorktreeCleanupError(`${getErrorMessage(error)}\n\nWorktree rollback incomplete:\n${failures.join("\n")}`);
		throw error;
	}

	return { cwd: repo.toplevel, worktrees, baseCommit: repo.baseCommit };
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	try {
		fs.mkdirSync(diffsDir, { recursive: true });
	} catch (error) {
		const message = `failed to create worktree diff artifact directory '${diffsDir}': ${getErrorMessage(error)}`;
		markWorktreesForPreservation(setup, message);
		return setup.worktrees.map((worktree, index) => {
			const agent = agents[index] ?? `task-${index + 1}`;
			const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
			return emptyDiff(index, agent, worktree.branch, patchPath, worktree.path, message);
		});
	}

	const diffs: WorktreeDiff[] = [];
	for (let index = 0; index < setup.worktrees.length; index++) {
		const worktree = setup.worktrees[index]!;
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
		try {
			diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath));
		} catch (error) {
			const message = `failed to capture worktree diff for task ${index + 1} (${agent}) at '${worktree.path}': ${getErrorMessage(error)}`;
			markWorktreesForPreservation(setup, message);
			writeEmptyPatch(patchPath);
			diffs.push(emptyDiff(index, agent, worktree.branch, patchPath, worktree.path, message));
		}
	}

	return diffs;
}

export function cleanupWorktrees(setup: WorktreeSetup): void {
	if (setup.preserveOnCleanup) return;
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		cleanupSingleWorktree(setup.cwd, setup.worktrees[index]!);
	}
	try { runGitChecked(setup.cwd, ["worktree", "prune"]); } catch (error) {
		console.error(`Failed to prune worktrees in '${setup.cwd}': ${getErrorMessage(error)}`);
	}
}

export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
	const changed = diffs.filter(hasWorktreeChanges);
	if (changed.length === 0) return "";

	const lines: string[] = ["=== Worktree Changes ===", ""];
	for (const diff of changed) {
		lines.push(
			`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
		);
		if (diff.captureError) {
			lines.push(`Diff capture failed: ${diff.captureError}`);
			if (diff.worktreePath) lines.push(`Preserved worktree: ${diff.worktreePath}`);
			lines.push(`Preserved branch: ${diff.branch}`);
		}
		if (diff.diffStat.trim().length > 0) {
			lines.push(diff.diffStat);
		}
		lines.push("");
	}

	const patchesDir = path.dirname(changed[0]!.patchPath);
	if (changed.some((diff) => !diff.captureError)) {
		lines.push(`Full patches: ${patchesDir}`);
	} else {
		lines.push("Patch artifacts unavailable; preserved worktrees contain the recoverable changes.");
	}
	return lines.join("\n").trimEnd();
}

export function formatParallelWorktreeSummary(
	worktreeSetup: WorktreeSetup | undefined,
	diffsDir: string,
	agents: string[],
): string {
	if (!worktreeSetup) return "";
	return formatWorktreeDiffSummary(diffWorktrees(worktreeSetup, agents, diffsDir));
}

export function appendWorktreeSummary(output: string, worktreeSummary: string): string {
	return worktreeSummary ? `${output}\n\n${worktreeSummary}` : output;
}
