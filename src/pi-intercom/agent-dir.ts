import { homedir } from "os";
import { join } from "path";

export function getPiAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured === "~") {
    return homedir();
  }
  if (configured?.startsWith("~/") === true) {
    return join(homedir(), configured.slice(2));
  }
  return configured === undefined || configured === ""
    ? join(homedir(), ".pi", "agent")
    : configured;
}
