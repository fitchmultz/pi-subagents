import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPiAgentDir } from "../pi-intercom/agent-dir.ts";
import { isChild, errorText } from "./host.ts";
import { launchAt, list, ownerDirectory, runDirectory, read } from "./storage.ts";
import { successorSchema, type Launch } from "./contracts.ts";
import { readCanonicalResult } from "./usage.ts";
import { actor, alive } from "./process.ts";
import { JournalTail, plainText } from "./journal-tail.ts";
import type { ObserverRow, Watch } from "./observe-screen.ts";

const STATUS_KEY = "agent-observer";

class Observer {
  private ctx?: ExtensionContext;
  private owner = "";
  private base = "";
  private timer?: NodeJS.Timeout;
  private close?: () => void;
  private refresh?: () => void;
  private readonly rows = new Map<string, ObserverRow>();
  private readonly launches = new Map<string, Launch>();
  private readonly finished = new Set<string>();
  private pending: string[] = [];
  private error = "";
  private total = 0;
  private readonly pi: ExtensionAPI;
  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }
  private dispose(): void {
    clearInterval(this.timer);
    this.close?.();
    this.close = undefined;
    this.refresh = undefined;
    this.ctx?.ui.setStatus(STATUS_KEY, undefined);
    this.ctx = undefined;
    this.rows.clear();
    this.launches.clear();
    this.finished.clear();
    this.pending = [];
    this.owner = "";
    this.base = "";
    this.error = "";
    this.total = 0;
  }
  private attach(ctx: ExtensionContext): void {
    this.dispose();
    if (ctx.mode !== "tui" || isChild()) {
      return;
    }
    this.ctx = ctx;
    this.owner = ctx.sessionManager.getSessionId();
    this.base = ownerDirectory(path.resolve(getPiAgentDir()), this.owner);
    this.scan();
    this.timer = setInterval(() => this.scan(), 1000);
    this.timer.unref();
  }
  private launch(id: string): Launch {
    const launch = this.launches.get(id) ?? launchAt(this.base, id, this.owner);
    this.launches.set(id, launch);
    return launch;
  }
  private live(launch: Launch, roots: Map<string, boolean>): boolean {
    const cached = roots.get(launch.rootId);
    if (cached !== undefined) {
      return cached;
    }
    const identity = actor(this.base, launch);
    const live = identity !== undefined && alive(identity);
    roots.set(launch.rootId, live);
    return live;
  }
  private load(id: string, roots: Map<string, boolean>): void {
    if (this.finished.has(id)) {
      return;
    }
    const launch = this.launch(id);
    const result = readCanonicalResult(this.base, launch);
    const finished = result !== undefined || this.hasSuccessor(id);
    const live = !finished && this.live(launch, roots);
    if (finished) {
      this.finished.add(id);
    }
    this.rows.set(id, {
      id,
      name: plainText(launch.name ?? id, 120),
      status: result?.status ?? (live ? "running" : "interrupted"),
      live,
      createdAt: launch.createdAt,
    });
  }
  private hasSuccessor(id: string): boolean {
    return (
      read(path.join(runDirectory(this.base, id), "successor.json"), successorSchema) !== undefined
    );
  }
  private loadVisible(id: string, roots: Map<string, boolean>): void {
    try {
      this.load(id, roots);
    } catch (error) {
      this.rows.set(id, { id, name: id, status: "unavailable", live: false, createdAt: 0 });
      this.error = plainText(errorText(error));
    }
  }
  private scan(): void {
    try {
      const ids = list(this.base);
      const present = new Set(ids);
      for (const id of this.rows.keys()) {
        if (!present.has(id)) {
          this.rows.delete(id);
          this.launches.delete(id);
          this.finished.delete(id);
        }
      }
      this.total = ids.length;
      this.pending = this.pending.filter((id) => present.has(id) && !this.finished.has(id));
      const newIds = ids.filter((id) => !this.rows.has(id) && !this.pending.includes(id));
      this.pending.unshift(...newIds);
      if (this.pending.length === 0) {
        this.pending = ids.filter((id) => !this.finished.has(id));
      }
      this.error = "";
      const roots = new Map<string, boolean>();
      this.pending.splice(0, 50).forEach((id) => this.loadVisible(id, roots));
    } catch (error) {
      this.error = plainText(errorText(error));
    }
    this.ctx?.ui.setStatus(STATUS_KEY, this.status());
    this.refresh?.();
  }
  private status(): string {
    const active = [...this.rows.values()].filter((row) => row.live).length;
    const checking = this.rows.size < this.total ? "+ (checking)" : "";
    const error = this.error.length > 0 ? " · inventory error" : "";
    return `Agents: ${active}${checking} active · ${this.total} runs${error} · /agents`;
  }
  private inventory(): ObserverRow[] {
    return [...this.rows.values()].sort((a, b) => {
      const order = Number(b.live) - Number(a.live);
      if (order !== 0) {
        return order;
      }
      const created = b.createdAt - a.createdAt;
      return created !== 0 ? created : a.id.localeCompare(b.id);
    });
  }
  private watch(id: string): Watch {
    const matches = list(this.base).filter((candidate) => candidate.startsWith(id));
    const exact = matches.includes(id);
    if (!exact && id.length < 8) {
      throw new Error("Use a full child run ID or a unique prefix of at least 8 characters.");
    }
    if (!exact && matches.length > 1) {
      throw new Error("Ambiguous child run prefix; use a longer ID from this parent session.");
    }
    const resolved = exact ? id : matches.at(0);
    if (resolved === undefined) {
      throw new Error("No child run matches that ID in this parent session.");
    }
    return this.openJournal(resolved);
  }
  private openJournal(id: string): Watch {
    let launch: Launch;
    try {
      launch = this.launch(id);
    } catch {
      throw new Error("Saved child metadata is unavailable or belongs to another parent.");
    }
    const directory = runDirectory(this.base, launch.rootId);
    if (path.dirname(path.resolve(launch.sessionFile)) !== path.resolve(directory)) {
      throw new Error("Child journal path is outside its saved conversation.");
    }
    return {
      tail: new JournalTail(launch.sessionFile, launch.sessionId),
      file: launch.sessionFile,
      id: launch.id,
      inherited: launch.context === "fork",
    };
  }
  private async show(args: string, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || isChild()) {
      ctx.ui.notify("/agents is a read-only interactive main-session view.", "info");
      return;
    }
    const { ObserverScreen } = await import("./observe-screen.ts");
    if (ctx.sessionManager.getSessionId() !== this.owner || !this.ctx) {
      return;
    }
    this.close?.();
    this.scan();
    await ctx.ui.custom<boolean>((tui, theme, keys, done) => {
      const screen = new ObserverScreen({
        data: {
          inventory: () => this.inventory(),
          row: (id) => this.rows.get(id),
          status: () => this.status(),
          error: () => this.error,
          watch: (id) => this.watch(id),
        },
        tui,
        theme,
        keys,
        done: () => done(true),
        selected: args.trim(),
      });
      this.close = () => done(true);
      this.refresh = () => screen.update();
      return {
        render: (width) => screen.render(width),
        handleInput: (data) => screen.handleInput(data),
        invalidate: () => screen.invalidate(),
        dispose: () => {
          screen.dispose();
          this.close = undefined;
          this.refresh = undefined;
        },
      };
    });
  }
  register(): void {
    this.pi.on("session_start", (_event, ctx) => this.attach(ctx));
    this.pi.on("session_shutdown", () => this.dispose());
    this.pi.registerCommand("agents", {
      description:
        "List this parent's children; /agents <run-id or unique 8+ prefix> watches native activity read-only",
      handler: (args, ctx) => this.show(args, ctx),
    });
  }
}
export default function observe(pi: ExtensionAPI): void {
  if (!isChild()) {
    new Observer(pi).register();
  }
}
