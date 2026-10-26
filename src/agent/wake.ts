import * as fs from "node:fs";
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
  private watcher?: fs.FSWatcher;
  private armed = "";
  private checked = "";
  private failed = false;
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
    if (this.watcher !== undefined && identity === this.armed) {
      return checked === this.checked ? "watching" : "changed";
    }
    // A replaced directory leaves an inode watch silent on Linux.
    this.close();
    return identity === "" || this.failed ? "unwatched" : this.arm(identity);
  }
  private arm(identity: string): WatchState {
    try {
      const watcher = fs.watch(this.directory, { persistent: false }, (_event, file) => {
        if (watcher === this.watcher && this.relevant(file)) {
          this.wake();
        }
      });
      watcher.on("error", () => {
        if (watcher === this.watcher) {
          this.failed = true;
          this.close();
          this.wake();
        }
      });
      this.watcher = watcher;
      this.armed = identity;
      return "armed";
    } catch (error) {
      // Unsupported platforms and watch limits keep their owner's polling fallback.
      this.failed = !missing(error);
      return "unwatched";
    }
  }
  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.armed = "";
  }
}

/** A coalesced wake for one owner loop; raised until that loop takes it. */
export class Wake {
  private raised = true;
  private resolve?: () => void;
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
