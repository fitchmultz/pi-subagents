import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getPiAgentDir } from "../agent-dir.ts";

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function sanitizePipeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
}

function agentDigest(agentDir: string): string {
	return createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
}

export function getLegacyBrokerSocketPath(agentDir: string = getPiAgentDir(), tempDir: string = tmpdir()): string {
	return join(tempDir, `pi-intercom-${agentDigest(agentDir)}.sock`);
}

export function getBrokerSocketPath(
	platform: NodeJS.Platform = process.platform,
	agentDir: string = getPiAgentDir(),
	tempDir: string = tmpdir(),
): string {
	if (platform === "win32") return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
	const suffix = `pi-intercom-${agentDigest(agentDir)}`;
	const preferred = join(tempDir, suffix, "broker.sock");
	return Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH_BYTES
		? preferred
		: join("/tmp", suffix, "broker.sock");
}

export function prepareBrokerSocketPath(
	platform: NodeJS.Platform = process.platform,
	agentDir: string = getPiAgentDir(),
): string {
	if (platform === "win32") return getBrokerSocketPath(platform, agentDir);
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

	const socketPath = getBrokerSocketPath(platform, agentDir);
	const brokerDir = dirname(socketPath);
	fs.mkdirSync(brokerDir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(brokerDir);
	const uid = process.getuid?.();
	if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
		throw new Error(`Unsafe intercom socket directory: ${brokerDir}`);
	}
	fs.chmodSync(brokerDir, 0o700);
	return socketPath;
}
