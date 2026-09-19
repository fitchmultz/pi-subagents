import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Node loads this before Pi selects its session and creates cwd-bound services.
// Use the SDK beside the actual CLI (bundled or unbundled), never our dev peer.
const configuration = process.env.PI_SUBAGENT_SESSION_CWD;
if (configuration) {
	const { sessionFile, cwd, nodeOptions } = JSON.parse(configuration) as {
		sessionFile: string;
		cwd: string;
		nodeOptions?: string;
	};
	delete process.env.PI_SUBAGENT_SESSION_CWD;
	// Shell tools and nested children must not inherit this launch's preload.
	if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
	else process.env.NODE_OPTIONS = nodeOptions;

	const sdkUrl = pathToFileURL(join(dirname(realpathSync(process.argv[1])), "index.js"));
	const { SessionManager }: typeof import("@earendil-works/pi-coding-agent") = await import(sdkUrl.href);
	const open = SessionManager.open;
	SessionManager.open = (file, sessionDir, cwdOverride) => {
		if (resolve(file) !== sessionFile) return open(file, sessionDir, cwdOverride);
		SessionManager.open = open;
		// Public Pi SDK override preserves the file, header, identity and history.
		return open(file, sessionDir, cwd);
	};
}
