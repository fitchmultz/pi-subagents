import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test process owns its home/storage. The suite runner removes their common
// parent after exit; direct runs must not read or write the real ~/.pi.
const suiteRoot = process.env.PI_SUBAGENT_TEMP_ROOT && process.env.HOME === process.env.PI_SUBAGENT_TEMP_ROOT
	? process.env.PI_SUBAGENT_TEMP_ROOT : undefined;
if (!suiteRoot) {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
	}
}
const root = mkdtempSync(join(suiteRoot ?? tmpdir(), "pi-subagents-test-"));
process.env.PI_SUBAGENT_TEMP_ROOT = root;
process.env.HOME = root;
delete process.env.PI_CODING_AGENT_DIR;
