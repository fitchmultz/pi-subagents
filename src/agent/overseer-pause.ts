import * as fs from "node:fs";
import * as path from "node:path";
import {
  escalationResolutionSchema,
  escalationSchema,
  type Escalation,
  type Launch,
} from "./contracts.ts";
import { read, runDirectory, write } from "./storage.ts";
import { DirectoryWatch, Wake } from "./wake.ts";

export type EscalationAnswer =
  | { readonly verdict: "approved" | "stopped" }
  | { readonly verdict: "steered"; readonly prompts: readonly string[] };

/** A paused native boundary takes corrections from its own actor, not from queued command files. */
export class EscalationPause {
  private readonly wake = new Wake();
  private readonly prompts: string[] = [];
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  steer(runId: string, prompt: string): boolean {
    if (runId !== this.runId) {
      return false;
    }
    this.prompts.push(prompt);
    this.wake.raise();
    return true;
  }

  async wait(
    base: string,
    escalation: Escalation,
    isStopping: () => boolean,
  ): Promise<EscalationAnswer> {
    const runDir = runDirectory(base, this.runId);
    const escalationFile = path.join(runDir, "escalation.json");
    const resolutionFile = path.join(runDir, "escalation-resolution.json");
    write(escalationFile, escalation);
    const watchRun = new DirectoryWatch(runDir, () => true, this.wake.raise);
    try {
      while (!isStopping()) {
        this.wake.take();
        watchRun.ensure();
        if (this.prompts.length > 0) {
          return { verdict: "steered", prompts: this.prompts };
        }
        const resolution = read(resolutionFile, escalationResolutionSchema);
        if (
          resolution?.escalationId === escalation.id &&
          (resolution.verdict === "approved" || resolution.verdict === "stopped")
        ) {
          return { verdict: resolution.verdict };
        }
        await this.wake.sleep(200);
      }
      return { verdict: "stopped" };
    } finally {
      watchRun.close();
      fs.rmSync(escalationFile, { force: true });
    }
  }
}

export function resolveActiveEscalation(
  base: string,
  launch: Launch,
  verdict: "approved" | "stopped",
): Escalation | undefined {
  const dir = runDirectory(base, launch.id);
  const active = read(path.join(dir, "escalation.json"), escalationSchema);
  if (active === undefined) {
    return undefined;
  }
  const resolutionFile = path.join(dir, "escalation-resolution.json");
  const previous = read(resolutionFile, escalationResolutionSchema);
  if (previous?.escalationId === active.id) {
    return undefined;
  }
  write(resolutionFile, {
    escalationId: active.id,
    verdict,
    ...(verdict === "approved" ? { diffDigest: active.diffDigest } : {}),
    at: Date.now(),
  });
  return active;
}
