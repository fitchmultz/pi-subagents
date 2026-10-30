import * as path from "node:path";
import type { BackgroundReporter } from "../shared/background-reporting.ts";
import { errorMessage } from "../shared/unknown.ts";
import { DirectoryWatch, type WatchState } from "./wake.ts";

/** Owns change hints for completion inputs and reports failures without losing polling. */
export class CompletionWatches {
  private readonly watches = new Map<string, DirectoryWatch>();
  private awaited: ReadonlySet<string> = new Set();
  private readonly reporter: BackgroundReporter;
  private readonly wake: () => void;
  constructor(reporter: BackgroundReporter, wake: () => void) {
    this.reporter = reporter;
    this.wake = wake;
  }

  update(
    base: string,
    legacy: readonly string[],
    awaited: ReadonlySet<string>,
  ): "poll" | "rescan" | "hints" {
    this.awaited = awaited;
    const directories = [
      ...new Set([base, ...legacy, ...[...awaited].map((file) => path.dirname(file))]),
    ];
    for (const [directory, watch] of this.watches) {
      if (!directories.includes(directory)) {
        watch.close();
        this.watches.delete(directory);
        this.reporter.recover(`watch:${directory}`);
      }
    }
    const states = directories.map((directory): [string, WatchState] => [
      directory,
      this.ensure(directory, directory === base || legacy.includes(directory)),
    ]);
    if (states.some(([directory, state]) => state === "unwatched" && !legacy.includes(directory))) {
      return "poll";
    }
    return states.some(([, state]) => state === "armed") ? "rescan" : "hints";
  }

  private ensure(directory: string, every: boolean): WatchState {
    let watch = this.watches.get(directory);
    if (watch === undefined) {
      watch = new DirectoryWatch(
        directory,
        (file) => every || file === null || this.awaited.has(path.join(directory, file)),
        this.wake,
      );
      this.watches.set(directory, watch);
    }
    const owner = `watch:${directory}`;
    try {
      const state = watch.ensure();
      this.reporter.recover(owner);
      return state;
    } catch (error) {
      watch.close();
      this.reporter.report(owner, `Agent directory watch ${directory}: ${errorMessage(error)}`);
      return "unwatched";
    }
  }

  close(): void {
    for (const [directory, watch] of this.watches) {
      watch.close();
      this.reporter.recover(`watch:${directory}`);
    }
    this.watches.clear();
    this.awaited = new Set();
  }
}
