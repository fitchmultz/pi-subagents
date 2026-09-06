import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getPiAgentDir } from "../agent-dir.ts";

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function agentDigest(agentDir: string, uid?: number): string {
	return createHash("sha256").update(uid === undefined ? agentDir : `${uid}:${agentDir}`).digest("hex").slice(0, 16);
}

export function getLegacyBrokerSocketPath(agentDir: string = getPiAgentDir(), tempDir: string = tmpdir()): string {
	return join(tempDir, `pi-intercom-${agentDigest(agentDir)}.sock`);
}

export function isOwnedBrokerSocket(socketPath: string): boolean {
	try {
		const stat = fs.lstatSync(socketPath);
		const uid = process.getuid?.();
		return stat.isSocket() && (uid === undefined || stat.uid === uid);
	} catch {
		return false;
	}
}

export function getBrokerSocketPath(
	agentDir: string = getPiAgentDir(),
	tempDir: string = tmpdir(),
	uid: number | undefined = process.getuid?.(),
): string {
	const suffix = `pi-intercom-${agentDigest(agentDir, uid)}`;
	const preferred = join(tempDir, suffix, "broker.sock");
	return Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH_BYTES
		? preferred
		: join("/tmp", suffix, "broker.sock");
}

export function prepareBrokerSocketPath(
	agentDir: string = getPiAgentDir(),
): string {
	const socketPath = getBrokerSocketPath(agentDir);
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
