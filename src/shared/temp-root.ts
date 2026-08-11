import * as fs from "node:fs";
import * as path from "node:path";
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

function removeOldEntries(root: string, now: number, statusPath?: (entryPath: string) => string): void {
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
			if (statusPath && entry.isDirectory()) {
				try {
					const status = JSON.parse(fs.readFileSync(statusPath(entryPath), "utf-8")) as { state?: string };
					if (status.state === "running" || status.state === "queued") continue;
				} catch {
					// Old malformed/incomplete directories are safe to remove.
				}
			}
			fs.rmSync(entryPath, { recursive: entry.isDirectory(), force: true });
		} catch {
			// Startup retention cleanup is best effort.
		}
	}
}

function nestedRouteStatusPath(routeRoot: string): string {
	const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, "route.json"), "utf-8")) as { rootRunId?: unknown };
	if (typeof metadata.rootRunId !== "string" || !metadata.rootRunId || metadata.rootRunId.includes("/") || metadata.rootRunId.includes("..")) {
		throw new Error("Invalid nested route metadata.");
	}
	return path.join(ASYNC_DIR, metadata.rootRunId, "status.json");
}

export function cleanupOldRunStorage(now = Date.now()): void {
	for (const [dir, statusPath] of [
		[ASYNC_DIR, (entryPath: string) => path.join(entryPath, "status.json")],
		[RESULTS_DIR, undefined],
		[path.join(TEMP_ROOT_DIR, "nested-subagent-runs"), undefined],
		[path.join(TEMP_ROOT_DIR, "nested-subagent-events"), nestedRouteStatusPath],
	] as const) {
		ensureSafeTempPath(dir);
		removeOldEntries(dir, now, statusPath);
	}
}
