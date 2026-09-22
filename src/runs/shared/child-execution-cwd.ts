import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const RESOLVE_CWD = "pi-change-working-dir:resolve-execution-cwd";
const SET_CWD = "pi-change-working-dir:set-execution-cwd";
const intentPath = (sessionFile: string): string => `${sessionFile}.subagent-cwd-init`;
type CwdIntent = { cwd?: string };
type CwdRequest = { sessionManager: ExtensionContext["sessionManager"]; path?: string; result?: { cwd: string; error?: string } };

/** Call once for a new fork or explicit resume override; undo only if launch fails before starting. */
export function requestChildExecutionCwd(sessionFile: string, cwd?: string): () => void {
	if (cwd !== undefined && !path.isAbsolute(cwd)) throw new Error("Child execution cwd must be absolute.");
	const previous = readIntent(sessionFile);
	fs.writeFileSync(intentPath(sessionFile), JSON.stringify({ cwd }), { mode: 0o600 });
	return () => {
		if (previous) fs.writeFileSync(intentPath(sessionFile), JSON.stringify(previous), { mode: 0o600 });
		else fs.unlinkSync(intentPath(sessionFile));
	};
}

function readIntent(sessionFile: string): CwdIntent | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(intentPath(sessionFile), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| ("cwd" in value && (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)))) {
		throw new Error("Invalid child execution cwd initialization request.");
	}
	return value as CwdIntent;
}

/** Freeze the new fork's requested directory once the actual launch cwd is known. */
export function prepareChildExecutionCwd(sessionFile: string, cwd?: string): void {
	const intent = readIntent(sessionFile);
	if (intent && intent.cwd === undefined) {
		if (!cwd) throw new Error("New fork execution cwd was not supplied.");
		requestChildExecutionCwd(sessionFile, cwd);
	}
}

export function hasExecutionCwdOwner(pi: Pick<ExtensionAPI, "getAllTools" | "getCommands">): boolean {
	// excludeTools can hide change_dir while the owner's /cwd command remains loaded.
	const fromOwner = ({ sourceInfo }: { sourceInfo: { source: string; path: string } }) =>
		/(?:^|[/\\:@])(?:pi-)?change-working-dir(?:[/\\@:.>]|$)/.test(`${sourceInfo.source}/${sourceInfo.path}`);
	return pi.getAllTools().some((tool) => tool.name === "change_dir" || fromOwner(tool))
		|| pi.getCommands().some((command) => command.source === "extension" && (/^cwd(?::\d+)?$/.test(command.name) || fromOwner(command)));
}

export function registerChildExecutionCwd(pi: ExtensionAPI): void {
	let initialized = false;
	pi.on("input", (_event, ctx) => {
		if (initialized) return;
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const intent = sessionFile ? readIntent(sessionFile) : undefined;
			const request: CwdRequest = { sessionManager: ctx.sessionManager };
			pi.events.emit(RESOLVE_CWD, request);
			if (request.result?.error) throw new Error(request.result.error);
			const owned = Boolean(request.result) || hasExecutionCwdOwner(pi);
			if (owned && !request.result?.cwd) throw new Error("The loaded directory extension did not resolve the child directory. Update pi-change-working-dir and ensure session startup has completed.");
			if (!intent) {
				initialized = true;
				return;
			}
			if (!intent.cwd) throw new Error("New fork execution cwd was not prepared before startup.");
			if (owned) {
				const selection: CwdRequest = { sessionManager: ctx.sessionManager, path: intent.cwd };
				pi.events.emit(SET_CWD, selection);
				if (!selection.result) throw new Error("The loaded directory extension did not initialize the child directory. Update pi-change-working-dir and ensure session startup has completed.");
				if (selection.result.error) throw new Error(selection.result.error);
				if (fs.realpathSync(selection.result.cwd) !== fs.realpathSync(intent.cwd)) throw new Error("The directory extension selected a different child directory.");
			} else if (fs.realpathSync(ctx.cwd) !== fs.realpathSync(intent.cwd)) {
				throw new Error("Native child directory does not match the requested execution cwd.");
			}
			// This is a launch intent, not another directory store. Only the owner persists selection.
			fs.unlinkSync(intentPath(sessionFile!));
			initialized = true;
		} catch (error) {
			console.error(`Subagent directory initialization failed: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
			// Native hook exceptions are swallowed. Handled input stops before provider/tool dispatch.
			return { action: "handled" };
		}
	});
}
