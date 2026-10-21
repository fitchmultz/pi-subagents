import * as path from "node:path";
import type { Launch } from "../../src/agent/contracts.ts";

export function usageLaunch(sessionFile: string): Launch {
  return {
    version: 1,
    id: "run",
    rootId: "run",
    owner: "parent",
    cwd: path.dirname(sessionFile),
    agentDir: path.dirname(sessionFile),
    sdk: "unused",
    entry: "unused",
    sessionFile,
    sessionId: "child",
    prompt: "Exact task",
    context: "fresh",
    provider: "p",
    model: "selected",
    thinking: "off",
    trusted: false,
    createdAt: 1,
  };
}
