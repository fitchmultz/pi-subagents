import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPiAgentDir } from "../agent-dir.ts";

function sanitizePipeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
}

export function getLegacyBrokerSocketPath(agentDir: string = getPiAgentDir()): string {
	const digest = createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
	return join(tmpdir(), `pi-intercom-${digest}.sock`);
}

export function getBrokerSocketPath(
	platform: NodeJS.Platform = process.platform,
	agentDir: string = getPiAgentDir(),
): string {
	if (platform === "win32") return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
	const digest = createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
	const legacyPath = getLegacyBrokerSocketPath(agentDir);
	try {
		const legacyStat = fs.lstatSync(legacyPath);
		const uid = process.getuid?.();
		if (legacyStat.isSocket() && (uid === undefined || legacyStat.uid === uid)) {
			fs.chmodSync(legacyPath, 0o600);
			return legacyPath;
		}
	} catch {
		// No live pre-0.33 socket to migrate through.
	}
	// macOS Unix-domain sockets have a short path limit; /tmp is its canonical short alias.
	const brokerDir = join(platform === "darwin" ? "/tmp" : tmpdir(), `pi-intercom-${digest}`);
	fs.mkdirSync(brokerDir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(brokerDir);
	const uid = process.getuid?.();
	if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) throw new Error(`Unsafe intercom socket directory: ${brokerDir}`);
	if (process.platform !== "win32") fs.chmodSync(brokerDir, 0o700);
	return join(brokerDir, "broker.sock");
}
