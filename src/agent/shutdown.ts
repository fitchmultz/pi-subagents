import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Launch, ProcessIdentity } from "./contracts.ts";
import { errorText } from "./host.ts";
import { alive, requestStop, signalProcess } from "./process.ts";
import { resolveActiveEscalation } from "./overseer-sentinel.ts";
import { launchAt, list } from "./storage.ts";
import { renderReceipt } from "./view.ts";

export function stopRun(
  base: string,
  launch: Launch,
  ctx: ExtensionContext | undefined,
  report: (message: string) => void,
): ReturnType<typeof renderReceipt> {
  resolveActiveEscalation(base, launch, "stopped");
  const { targets: live, command: id } = requestStop(base, launch);
  if (live.length === 0) {
    return renderReceipt(base, launch, ctx, {
      stopAcknowledged: false,
      note: "No matching live actor or owned shell; process exit code remains unknown.",
    });
  }
  const escalation = setTimeout(() => {
    try {
      for (const target of live) {
        signalProcess(target, "SIGKILL");
      }
    } catch (error) {
      report(`Agent stop escalation ${launch.id}: ${errorText(error)}`);
    }
  }, 3000);
  escalation.unref();
  return renderReceipt(base, launch, ctx, {
    stopRequest: id,
    stopAcknowledged: false,
    note: "Stop requested; neither native admission nor process exit is implied.",
  });
}

export async function stopChildren(
  base: string,
  owner: string,
  report: (message: string) => void,
): Promise<void> {
  const roots = new Set<string>();
  const targets: ProcessIdentity[] = [];
  for (const id of list(base)) {
    try {
      const launch = launchAt(base, id, owner);
      if (!roots.has(launch.rootId)) {
        roots.add(launch.rootId);
        targets.push(
          ...requestStop(base, launch, (error) => {
            report(`Child shutdown ${id}: ${errorText(error)}`);
          }).targets,
        );
      }
    } catch (error) {
      report(`Child shutdown ${id}: ${errorText(error)}`);
    }
  }
  await waitForExit(targets, 3000);
  for (const target of targets) {
    try {
      signalProcess(target, "SIGKILL");
    } catch (error) {
      report(`Child shutdown ${target.pid}: ${errorText(error)}`);
    }
  }
  await waitForExit(targets, 1000);
  if (targets.some(alive)) {
    report("Child shutdown could not confirm every owned process exit.");
  }
}

async function waitForExit(targets: readonly ProcessIdentity[], timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && targets.some(alive)) {
    // Join actual process exit while native abort persists the interrupted turn.
    await delay(25);
  }
}
