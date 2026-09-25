import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import first in every test file. scripts/run-tests.mjs points HOME at its temp root;
// direct `node --test <file>` runs must not read or write the real ~/.pi.
if (!process.env.PI_SUBAGENT_TEMP_ROOT || process.env.HOME !== process.env.PI_SUBAGENT_TEMP_ROOT) {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
	}
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
	process.env.PI_SUBAGENT_TEMP_ROOT = root;
	process.env.HOME = root;
	delete process.env.PI_CODING_AGENT_DIR;
}
