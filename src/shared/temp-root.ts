import * as fs from "node:fs";
import * as path from "node:path";
import { isSafeNestedPathId } from "../runs/shared/nested-path.ts";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR } from "./types.ts";

const MAX_RUN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function ensureTempRoot(): void {
	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(TEMP_ROOT_DIR);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe pi-subagents temp root: ${TEMP_ROOT_DIR}`);
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) throw new Error(`pi-subagents temp root is owned by another user: ${TEMP_ROOT_DIR}`);
	if (process.platform !== "win32") fs.chmodSync(TEMP_ROOT_DIR, 0o700);
}

export function ensureSafeTempPath(candidate: string): void {
	const root = path.resolve(TEMP_ROOT_DIR);
	const resolved = path.resolve(candidate);
	const relative = path.relative(root, resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
	ensureTempRoot();
	let current = root;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink in pi-subagents temp path: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

// Missing or malformed status means the entry is incomplete and safe to remove.
// Operational read failures throw so the caller fails closed instead of deleting live work.
function activeStatus(statusFile: string): boolean {
	try {
		const status = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as { state?: string };
		return status.state === "running" || status.state === "queued";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
		throw error;
	}
}

function removeOldEntries(root: string, now: number, keepActive?: (entryPath: string) => boolean): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		try {
			const stat = fs.lstatSync(entryPath);
			if (now - stat.mtimeMs <= MAX_RUN_AGE_MS) continue;
			if (keepActive && entry.isDirectory() && keepActive(entryPath)) continue;
			fs.rmSync(entryPath, { recursive: entry.isDirectory(), force: true });
		} catch {
			// Startup retention cleanup is best effort; entries that fail closed are skipped.
		}
	}
}

// A route is live while anything still writes into it (nested descendants can outlive a
// terminal root, and foreground roots have no async status at all) or while its root run
// reports an active state. Writes land in events/, controls/, and registry.json; route-root
// mtime alone only advances on creation and registry projection.
function nestedRouteActive(routeRoot: string, now: number): boolean {
	for (const name of ["events", "controls", "registry.json"]) {
		try {
			if (now - fs.statSync(path.join(routeRoot, name)).mtimeMs <= MAX_RUN_AGE_MS) return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	let metadata: { rootRunId?: unknown };
	try {
		metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, "route.json"), "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
		throw error;
	}
	if (!isSafeNestedPathId(metadata.rootRunId)) return false;
	return activeStatus(path.join(ASYNC_DIR, metadata.rootRunId, "status.json"));
}

export function cleanupOldRunStorage(now = Date.now()): void {
	for (const [dir, keepActive] of [
		[ASYNC_DIR, (entryPath: string) => activeStatus(path.join(entryPath, "status.json"))],
		[RESULTS_DIR, undefined],
		[path.join(TEMP_ROOT_DIR, "nested-subagent-runs"), undefined],
		[path.join(TEMP_ROOT_DIR, "nested-subagent-events"), (entryPath: string) => nestedRouteActive(entryPath, now)],
	] as const) {
		ensureSafeTempPath(dir);
		removeOldEntries(dir, now, keepActive);
	}
}
