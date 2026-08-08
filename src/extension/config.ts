import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";

export function loadConfig(): ExtensionConfig {
	const configPath = path.join(getAgentDir(), "extensions", "subagent", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
			const trust = config.projectTrust;
			const childRuns = typeof trust === "object" && trust !== null ? trust.childRuns : trust;
			if (childRuns !== undefined && childRuns !== "inherit" && childRuns !== "approve" && childRuns !== "no-approve") {
				console.error(`Invalid projectTrust in '${configPath}'; child runs will use no-approve.`);
				config.projectTrust = "no-approve";
			}
			return config;
		}
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}
