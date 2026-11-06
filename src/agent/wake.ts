import * as fs from "node:fs";
import assert from "node:assert/strict";
import { journalStamp } from "../shared/native-journal.ts";
import { missing } from "./storage.ts";

/** Identity and change stamp of a path; "" when absent. */
export function pathStamp(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
    return stat === undefined ? "" : journalStamp(stat);
  } catch {
    return "unreadable";
  }
}

/**
 * `armed`: hints start now, so reconcile anything published earlier.
 * `changed`: the directory's own entries changed since the previous check, which also
 * covers hints the OS dropped.
 */
export type WatchState = "unwatched" | "armed" | "changed" | "watching";

/** Native change hints for one directory identity; owners still reconcile canonical files. */
export class DirectoryWatch {
  private state:
    | { readonly kind: "unarmed" | "polling" }
    | { readonly kind: "armed"; readonly watcher: fs.FSWatcher; readonly identity: string } = {
    kind: "unarmed",
  };
  private checked = "";
  private readonly directory: string;
  private readonly relevant: (file: string | null) => boolean;
  private readonly wake: () => void;
  constructor(directory: string, relevant: (file: string | null) => boolean, wake: () => void) {
    this.directory = directory;
    this.relevant = relevant;
    this.wake = wake;
  }
  ensure(): WatchState {
    const stat = fs.statSync(this.directory, { bigint: true, throwIfNoEntry: false });
    const identity = stat?.isDirectory() === true ? `${stat.dev}:${stat.ino}` : "";
    const checked = this.checked;
    this.checked = stat === undefined ? "" : `${identity}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (this.state.kind === "armed" && identity === this.state.identity) {
      return checked === this.checked ? "watching" : "changed";
    }
    // A replaced directory leaves an inode watch silent on Linux.
    this.close();
    return identity === "" || this.state.kind === "polling" ? "unwatched" : this.arm(identity);
  }
  private arm(identity: string): WatchState {
    try {
      const watcher = fs.watch(this.directory, { persistent: false }, (_event, file) => {
        if (this.state.kind === "armed" && watcher === this.state.watcher && this.relevant(file)) {
          this.wake();
        }
      });
      watcher.on("error", () => {
        if (this.state.kind === "armed" && watcher === this.state.watcher) {
          watcher.close();
          this.state = { kind: "polling" };
          this.wake();
        }
      });
      this.state = { kind: "armed", watcher, identity };
      return "armed";
    } catch (error) {
      // Unsupported platforms and watch limits keep their owner's polling fallback.
      this.state = { kind: missing(error) ? "unarmed" : "polling" };
      return "unwatched";
    }
  }
  close(): void {
    if (this.state.kind === "armed") {
      this.state.watcher.close();
      this.state = { kind: "unarmed" };
    }
  }
}

/** A coalesced wake for one owner loop; raised until that loop takes it. */
export class Wake {
  private raised = true;
  private resolve?: (() => void) | undefined;
  readonly raise = (): void => {
    this.raised = true;
    this.resolve?.();
  };
  take(): boolean {
    const raised = this.raised;
    this.raised = false;
    return raised;
  }
  /** Returns at once for a wake raised since the last take. */
  async sleep(ms: number): Promise<void> {
    assert.equal(this.resolve, undefined, "A Wake belongs to one waiting owner loop.");
    if (this.raised) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<"woken" | "elapsed">();
    const timer = setTimeout(() => {
      resolve("elapsed");
    }, ms);
    this.resolve = () => {
      resolve("woken");
    };
    await promise;
    clearTimeout(timer);
    this.resolve = undefined;
  }
}
