import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

function isIntercomPackage(packageRoot) {
	try {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		return manifest?.name === "pi-intercom"
			&& Array.isArray(manifest?.pi?.extensions)
			&& manifest.pi.extensions.length > 0;
	} catch {
		return false;
	}
}

export function prepareIntercomSmokePackage(tempRoot, repoRoot) {
	const explicitPath = process.env.PI_INTERCOM_PATH?.trim();
	if (explicitPath) {
		const packageRoot = resolve(explicitPath);
		if (!isIntercomPackage(packageRoot)) {
			throw new Error(`PI_INTERCOM_PATH is not a pi-intercom package: ${packageRoot}`);
		}
		return { packageRoot, source: "PI_INTERCOM_PATH", fixture: false };
	}

	const adjacentRoot = resolve(repoRoot, "..", "pi-intercom");
	if (isIntercomPackage(adjacentRoot)) {
		return { packageRoot: adjacentRoot, source: "adjacent checkout", fixture: false };
	}

	const packageRoot = join(tempRoot, "pi-intercom-smoke-companion");
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
		name: "pi-intercom",
		version: "0.0.0-smoke",
		private: true,
		type: "module",
		pi: { extensions: ["./index.ts"] },
	}, null, 2)}\n`);
	writeFileSync(join(packageRoot, "index.ts"), "export default function piIntercomSmokeCompanion() {}\n");
	return { packageRoot, source: "isolated smoke fixture", fixture: true };
}
