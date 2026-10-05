import * as fs from "node:fs";
import * as path from "node:path";
import { identity } from "./source-file.ts";
import type { SourceRow } from "./rows.ts";

interface WatchEvents {
  readonly run: (id: string) => void;
  readonly source: (id: string) => void;
  readonly schedule: () => void;
}
/** Owns native handles, physical-directory identity and co-located run/source subscriptions. */
export class SourceWatches {
  private readonly runs = new Set<string>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly sourceWatchers = new Map<string, fs.FSWatcher>();
  private readonly identities = new WeakMap<fs.FSWatcher, string>();
  private readonly sources = new Map<string, Map<string, string>>();
  private readonly root: string;
  private readonly events: WatchEvents;
  constructor(agentDir: string, events: WatchEvents) {
    this.root = path.join(agentDir, "sessions", "subagent-runs");
    this.events = events;
  }
  private handle(
    directory: string,
    recursive: boolean,
    listener: (name: string | null) => void,
    source = false,
  ): void {
    const handles = source ? this.sourceWatchers : this.watchers;
    const existing = handles.get(directory);
    try {
      const physical = identity(fs.statSync(directory, { bigint: true }));
      if (existing && this.identities.get(existing) === physical) {
        return;
      }
      const watcher = fs.watch(directory, { recursive }, (event, name) => {
        const filename = name?.toString() ?? null;
        if (
          event === "rename" &&
          filename === path.basename(directory) &&
          handles.get(directory) === watcher
        ) {
          this.identities.delete(watcher);
          this.handle(directory, recursive, listener, source);
          listener(null);
        } else {
          listener(filename);
        }
        this.events.schedule();
      });
      this.identities.set(watcher, physical);
      this.retireOnClose(directory, watcher, source);
      handles.set(directory, watcher);
      // Native close fences macOS re-registration; admit the replacement first.
      existing?.close();
    } catch {
      if (existing && handles.get(directory) === existing) {
        this.identities.delete(existing);
      }
      // Known-handle census recovers absent directories and dropped native watches.
    }
  }
  private retireOnClose(directory: string, watcher: Readonly<fs.FSWatcher>, source: boolean): void {
    const handles = source ? this.sourceWatchers : this.watchers;
    const retire = () => {
      if (handles.get(directory) === watcher) {
        handles.delete(directory);
      }
    };
    watcher.on("error", () => {
      watcher.close();
      retire();
    });
    watcher.on("close", retire);
  }
  private reset(directory: string): void {
    for (const handles of [this.watchers, this.sourceWatchers]) {
      const watcher = handles.get(directory);
      if (watcher) {
        this.identities.delete(watcher);
      }
    }
    for (const id of this.sources.get(directory)?.keys() ?? []) {
      this.events.source(id);
    }
  }
  sourceDirectory(directory: string): void {
    if (!this.sources.has(directory)) {
      return;
    }
    this.handle(
      directory,
      false,
      (name) => {
        for (const [id, filename] of this.sources.get(directory) ?? []) {
          if (name === null || name.length === 0 || filename === name) {
            this.events.source(id);
          }
        }
      },
      true,
    );
  }
  install(runIds: readonly string[], sources: readonly Pick<SourceRow, "id" | "path">[]): void {
    for (const id of runIds) {
      this.runs.add(id);
    }
    // Observe only admitted trees. Foreign run directory churn never causes a global scan.
    this.handle(this.root, false, (name) => {
      let ids: Iterable<string> = this.runs;
      if (name !== null && name.length > 0) {
        ids = this.runs.has(name) ? [name] : [];
      }
      for (const id of ids) {
        this.reset(path.join(this.root, id));
        this.events.run(id);
      }
    });
    for (const id of runIds) {
      const directory = path.join(this.root, id);
      this.handle(directory, true, (name) => {
        if (name === null || name.length === 0) {
          this.reset(directory);
        }
        this.events.run(id);
      });
      this.sourceDirectory(directory);
    }
    for (const source of sources) {
      const directory = path.dirname(source.path);
      let linked = this.sources.get(directory);
      if (!linked) {
        linked = new Map();
        this.sources.set(directory, linked);
      }
      linked.set(source.id, path.basename(source.path));
      this.sourceDirectory(directory);
    }
  }
  forget(source: Pick<SourceRow, "id" | "path">): void {
    this.sources.get(path.dirname(source.path))?.delete(source.id);
  }
  close(): void {
    for (const watcher of [...this.watchers.values(), ...this.sourceWatchers.values()]) {
      watcher.close();
    }
    this.watchers.clear();
    this.sourceWatchers.clear();
    this.sources.clear();
    this.runs.clear();
  }
}
