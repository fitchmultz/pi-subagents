import * as path from "node:path";
import * as fs from "node:fs";
import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText } from "@earendil-works/pi-tui";
import { actionText } from "../shared/tui-action.ts";
import { getPiAgentDir } from "../pi-intercom/agent-dir.ts";
import { isChild, errorText } from "./host.ts";
import { launchAt, list, ownerDirectory, runDirectory, read } from "./storage.ts";
import { successorSchema, type Launch } from "./contracts.ts";
import { readCanonicalResult } from "./usage.ts";
import { actor, observeAlive } from "./process.ts";
import { plainText } from "./journal-tail.ts";
import { ObservationClient, type Watch } from "./observe-client.ts";
import { adoptedJournal } from "./saved.ts";
import type { ObserverRow } from "./observe-chrome.ts";

const STATUS_KEY = "agent-observer";
type Roots = Map<string, ReturnType<typeof actor>>;
type Commit = (live: ReadonlyMap<string, boolean>) => void;

class Observer {
  private ctx?: ExtensionContext;
  private owner = "";
  private base = "";
  private timer?: NodeJS.Timeout;
  private scanning?: Promise<void>;
  private rescan = false;
  private close?: () => void;
  private refresh?: () => void;
  private readonly rows = new Map<string, ObserverRow>();
  private readonly peers = new Map<string, { token: string; client: ObservationClient }>();
  private watcher?: fs.FSWatcher;
  private widgetVisible = false;
  private widgetSignature = "";
  private widgetRender?: () => void;
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
    this.timer = undefined;
    this.scanning = undefined;
    this.rescan = false;
    this.watcher?.close();
    this.watcher = undefined;
    for (const peer of this.peers.values()) {
      peer.client.close();
    }
    this.peers.clear();
    this.widgetVisible = false;
    this.widgetSignature = "";
    this.widgetRender = undefined;
    this.close?.();
    this.close = undefined;
    this.refresh = undefined;
    this.ctx?.ui.setWidget(STATUS_KEY, undefined);
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
    fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
    try {
      const watcher = fs.watch(this.base, { recursive: true }, (_event, file) => {
        if (
          this.watcher === watcher &&
          this.timer === undefined &&
          (file === null || /(?:launch|result|successor|process)\.json$/.test(file))
        ) {
          this.scan();
        }
      });
      this.watcher = watcher;
      watcher.on("error", () => {
        if (this.watcher !== watcher) {
          return;
        }
        watcher.close();
        this.watcher = undefined;
        this.scan();
      });
    } catch {
      /* Sparse native execution events still wake inventory without an idle poll. */
    }
    this.scan();
  }
  private launch(id: string): Launch {
    const launch = this.launches.get(id) ?? launchAt(this.base, id, this.owner);
    this.launches.set(id, launch);
    return launch;
  }
  /** Reads durable metadata now; unfinished rows commit after their root's batched liveness. */
  private load(id: string, roots: Roots): Commit | undefined {
    if (this.finished.has(id)) {
      return undefined;
    }
    const launch = this.launch(id);
    const result = readCanonicalResult(this.base, launch);
    const finished = result !== undefined || this.hasSuccessor(id);
    if (finished) {
      this.finished.add(id);
    } else if (!roots.has(launch.rootId)) {
      roots.set(launch.rootId, actor(this.base, launch));
    }
    return (live) => {
      const running = !finished && live.get(launch.rootId) === true;
      this.rows.set(id, {
        id,
        name: plainText(launch.name ?? id, 120),
        status: result?.status ?? (running ? "running" : "interrupted"),
        live: running,
        createdAt: launch.createdAt,
        activity: this.peers.get(id)?.client.activity,
      });
    };
  }
  private hasSuccessor(id: string): boolean {
    return (
      read(path.join(runDirectory(this.base, id), "successor.json"), successorSchema) !== undefined
    );
  }
  private loadVisible(id: string, roots: Roots): Commit | undefined {
    try {
      return this.load(id, roots);
    } catch (error) {
      this.rows.set(id, { id, name: id, status: "unavailable", live: false, createdAt: 0 });
      this.error = plainText(errorText(error));
      return undefined;
    }
  }
  private loadBatch(roots: Roots): Commit[] {
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
      return this.pending.splice(0, 50).flatMap((id) => this.loadVisible(id, roots) ?? []);
    } catch (error) {
      this.error = plainText(errorText(error));
      return [];
    }
  }
  /** One scan at a time; triggers during a scan coalesce into one follow-up. */
  private scan(): void {
    if (this.scanning !== undefined) {
      this.rescan = true;
      return;
    }
    const scanning = this.update()
      .catch((error: unknown) => {
        this.error = plainText(errorText(error));
      })
      .finally(() => {
        if (this.scanning !== scanning) {
          return;
        }
        this.scanning = undefined;
        if (this.rescan) {
          this.rescan = false;
          this.scan();
        }
      });
    this.scanning = scanning;
  }
  private async update(): Promise<void> {
    const ctx = this.ctx;
    const roots: Roots = new Map();
    const commits = this.loadBatch(roots);
    const claims = [...roots].flatMap(([root, identity]) => (identity ? [{ root, identity }] : []));
    const verdicts = await observeAlive(claims.map(({ identity }) => identity));
    if (this.ctx !== ctx) {
      return;
    }
    const live = new Map(claims.map(({ root }, index) => [root, verdicts[index]]));
    for (const commit of commits) {
      commit(live);
    }
    this.activity();
    this.widget();
    this.refresh?.();
    const periodic = this.pending.length > 0 || [...this.rows.values()].some((row) => row.live);
    if (periodic && !this.timer) {
      this.timer = setInterval(() => this.scan(), 1000);
      this.timer.unref();
    } else if (!periodic) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  private activity(): void {
    const visible = this.strip()
      .filter((entry) => entry.live)
      .slice(0, 4);
    const ids = new Set(visible.map((entry) => entry.id));
    for (const [id, peer] of this.peers) {
      if (!ids.has(id) || peer.client.closed) {
        peer.client.close();
        this.peers.delete(id);
      }
    }
    for (const row of visible) {
      if (this.peers.has(row.id)) {
        continue;
      }
      try {
        const launch = this.launch(row.id);
        const identity = actor(this.base, launch);
        if (!identity) {
          continue;
        }
        const client = new ObservationClient(
          { token: identity.token, rootId: launch.rootId, sessionId: launch.sessionId },
          "activity",
          () => {
            if (this.peers.get(row.id)?.client !== client) {
              return;
            }
            const current = this.rows.get(row.id);
            if (current) {
              current.activity = client.connected ? client.activity : "Reconnecting";
            }
            this.widget();
          },
        );
        this.peers.set(row.id, { token: identity.token, client });
      } catch {
        // Older or not-yet-ready actors still have a known run status, but no live phase.
      }
    }
  }
  private widget(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const rows = this.strip();
    if (rows.length === 0 && this.rows.size === this.total && this.error.length === 0) {
      if (this.widgetVisible) {
        ctx.ui.setWidget(STATUS_KEY, undefined);
      }
      this.widgetVisible = false;
      this.widgetSignature = "";
      return;
    }
    const signature = JSON.stringify([this.status(), rows.slice(0, 4), rows.length]);
    if (signature === this.widgetSignature) {
      return;
    }
    this.widgetSignature = signature;
    if (this.widgetVisible) {
      this.widgetRender?.();
      return;
    }
    this.widgetVisible = true;
    ctx.ui.setWidget(
      STATUS_KEY,
      (tui, theme) => {
        this.widgetRender = () => {
          tui.requestRender();
        };
        const content = new Container();
        const open = (id: string) => {
          if (ctx !== this.ctx) {
            return;
          }
          void this.show(id, ctx).catch((error: unknown) => {
            ctx.ui.notify(errorText(error), "error");
          });
        };
        return {
          render: (width) => {
            const strip = this.strip();
            const visible = strip.slice(0, 4);
            content.clear();
            content.addChild(actionText(theme.fg("accent", this.status()), () => open("")));
            for (const row of visible) {
              const glyph = row.live ? "●" : "○";
              const color = row.live ? "accent" : "warning";
              content.addChild(
                actionText(
                  `${theme.fg(color, glyph)} ${theme.bold(row.name)} · ${row.activity ?? row.status}`,
                  () => open(row.id),
                ),
              );
            }
            if (strip.length > visible.length) {
              content.addChild(
                actionText(
                  theme.fg("dim", `+${strip.length - visible.length} more · /agents`),
                  () => open(""),
                ),
              );
            }
            if (this.error.length > 0) {
              content.addChild(new TruncatedText(theme.fg("warning", this.error), 0, 0));
            }
            return content.render(width);
          },
          handleMouse: (event) => content.handleMouse(event),
          invalidate: () => {
            // Render reads current rows, expansion and theme on every frame.
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }
  private status(): string {
    const active = [...this.rows.values()].filter((row) => row.live).length;
    const checking = this.rows.size < this.total;
    const error = this.error.length > 0 ? " · inventory error" : "";
    return `Agents: ${active}${checking ? "+" : ""} active${checking ? " (checking…)" : ""} · ${this.total} runs${error} · /agents`;
  }
  private inventory(): ObserverRow[] {
    return [...this.rows.values()]
      .filter((row) => row.status !== "completed")
      .sort((a, b) => {
        const order = Number(b.live) - Number(a.live);
        if (order !== 0) {
          return order;
        }
        const created = b.createdAt - a.createdAt;
        return created !== 0 ? created : a.id.localeCompare(b.id);
      });
  }
  /** The always-visible strip shows active work and unreadable runs; /agents keeps history. */
  private strip(): ObserverRow[] {
    return this.inventory().filter((row) => row.live || row.status === "unavailable");
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
    if (
      path.dirname(path.resolve(launch.sessionFile)) !== path.resolve(directory) &&
      !adoptedJournal(this.base, launch)
    ) {
      throw new Error("Child journal path is outside its saved conversation.");
    }
    const identity = actor(this.base, launch);
    return {
      launch,
      identity: identity && {
        token: identity.token,
        rootId: launch.rootId,
        sessionId: launch.sessionId,
      },
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
    await ctx.ui.custom<boolean>(
      (tui, theme, keys, done) => {
        const screen = new ObserverScreen({
          data: {
            inventory: () => this.inventory(),
            checking: () => this.rows.size < this.total,
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
          hideThinking: SettingsManager.create(ctx.cwd, getPiAgentDir()).getHideThinkingBlock(),
        });
        this.close = () => done(true);
        this.refresh = () => screen.update();
        const dispose = screen.dispose.bind(screen);
        screen.dispose = () => {
          dispose();
          this.close = undefined;
          this.refresh = undefined;
        };
        return screen;
      },
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
      },
    );
  }
  register(): void {
    this.pi.on("session_start", (_event, ctx) => this.attach(ctx));
    this.pi.on("session_shutdown", () => this.dispose());
    this.pi.on("tool_execution_end", (event) => {
      if (
        this.ctx &&
        this.watcher === undefined &&
        (event.toolName === "delegate" || event.toolName === "agent_runs")
      ) {
        this.scan();
      }
    });
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
