import { setTimeout as delay } from "node:timers/promises";
import type { ProcessIdentity } from "./contracts.ts";
import { errorText } from "./host.ts";
import { alive, requestStop, signalProcess } from "./process.ts";
import { launchAt, list } from "./storage.ts";

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
    // oxlint-disable-next-line no-await-in-loop
    await delay(25);
  }
}
