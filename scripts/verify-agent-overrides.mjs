#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultFitchKitRoot = "/Users/mitchfultz/Projects/AI/pi-fitch-kit";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: node scripts/verify-agent-overrides.mjs [--json]\n\nVerifies this personal fork's pi-fitch-kit agent overrides are synced.\n\nChecks:\n  - pi-fitch-kit/agents exists\n  - every bundled pi-subagents agent name has a source-managed pi-fitch-kit agent\n  - ~/.pi/agent/agents/<name>.md is a symlink to that source file\n  - symlinks point at ~/.pi/agent/agents, not ~/.agents/agents\n\nEnvironment:\n  PI_FITCH_KIT_DIR    Override pi-fitch-kit repo path (default: ${defaultFitchKitRoot})\n  PI_CODING_AGENT_DIR Override Pi user agent dir (default: ~/.pi/agent)\n\nRepair if this fails:\n  pi install ${defaultFitchKitRoot} --approve\n  # or fallback when Pi is not running:\n  bash ${defaultFitchKitRoot}/scripts/sync-agents.sh\n\nExit codes:\n  0  overrides are synced\n  1  override source or symlink verification failed`);
	process.exit(0);
}

const json = process.argv.includes("--json");
const fitchKitRoot = path.resolve(process.env.PI_FITCH_KIT_DIR ?? defaultFitchKitRoot);
const sourceDir = path.join(fitchKitRoot, "agents");
const piAgentDir = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
const targetDir = path.join(piAgentDir, "agents");
const wrongLegacyTargetDir = path.join(os.homedir(), ".agents", "agents");

function listAgentFiles(dir) {
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".chain.md")))
		.map((entry) => entry.name)
		.sort();
}

function resolvedSymlinkTarget(targetPath) {
	const linkTarget = fs.readlinkSync(targetPath);
	return path.resolve(path.dirname(targetPath), linkTarget);
}

const failures = [];
let sourceFiles = [];
let bundledAgentFiles = [];

if (!fs.existsSync(sourceDir)) {
	failures.push(`pi-fitch-kit agent source directory not found: ${sourceDir}`);
} else {
	sourceFiles = listAgentFiles(sourceDir);
}

const bundledAgentDir = path.join(repoRoot, "agents");
if (!fs.existsSync(bundledAgentDir)) {
	failures.push(`bundled agent directory not found: ${bundledAgentDir}`);
} else {
	bundledAgentFiles = listAgentFiles(bundledAgentDir);
}

if (!fs.existsSync(targetDir)) {
	failures.push(`Pi user agent directory not found: ${targetDir}`);
}

const sourceSet = new Set(sourceFiles);
let verified = 0;
for (const name of bundledAgentFiles) {
	if (!sourceSet.has(name)) {
		failures.push(`missing pi-fitch-kit override source for bundled agent ${name}: ${path.join(sourceDir, name)}`);
		continue;
	}
	const sourcePath = path.join(sourceDir, name);
	const targetPath = path.join(targetDir, name);
	if (!fs.existsSync(targetPath)) {
		failures.push(`missing synced override symlink: ${targetPath}`);
		continue;
	}
	const stat = fs.lstatSync(targetPath);
	if (!stat.isSymbolicLink()) {
		failures.push(`override target is not a symlink: ${targetPath}`);
		continue;
	}
	const actual = resolvedSymlinkTarget(targetPath);
	if (actual !== sourcePath) {
		failures.push(`override symlink mismatch: ${targetPath} -> ${actual}; expected ${sourcePath}`);
		continue;
	}
	verified += 1;
}

if (fs.existsSync(wrongLegacyTargetDir) && wrongLegacyTargetDir === targetDir) {
	failures.push(`override target unexpectedly resolves to legacy ~/.agents path: ${wrongLegacyTargetDir}`);
}

const result = {
	valid: failures.length === 0,
	fitchKitRoot,
	sourceDir,
	targetDir,
	bundledAgents: bundledAgentFiles.length,
	sourceAgents: sourceFiles.length,
	verifiedOverrides: verified,
	failures,
};

if (json) {
	console.log(JSON.stringify(result, null, 2));
} else if (result.valid) {
	console.log(`[agent-overrides] verified ${verified}/${bundledAgentFiles.length} bundled agent override symlink(s) from ${sourceDir} to ${targetDir}`);
} else {
	console.error(`[agent-overrides] verification failed for ${targetDir}`);
	for (const failure of failures) console.error(`- ${failure}`);
	console.error(`Repair: pi install ${fitchKitRoot} --approve`);
	console.error(`Fallback: bash ${path.join(fitchKitRoot, "scripts", "sync-agents.sh")}`);
}

process.exit(result.valid ? 0 : 1);
