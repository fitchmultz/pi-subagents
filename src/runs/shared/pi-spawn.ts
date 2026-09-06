import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
	return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}

export function getPiSpawnCommand(args: string[]): { command: string; args: string[] } {
	return { command: "pi", args };
}
