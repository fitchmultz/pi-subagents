import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isRecord, recordAt, type UnknownRecord } from "../shared/unknown.ts";
import {
  overseerLiveStateSchema,
  THINKING_LEVELS,
  type Launch,
  type OverseerLaunch,
} from "./contracts.ts";
import { notifyInventory } from "./inventory-events.ts";
import { read, write } from "./storage.ts";
import type { DelegateInput } from "./tool-schemas.ts";

export const OVERSEER_ENTRY_TYPE = "subagents-overseer";
export const OVERSEER_STATE_FILE = "overseer.json";
export const DEFAULT_OVERSEER_MODEL = "inherit";
export const DEFAULT_OVERSEER_JUDGE = "auto";

/** Live parent overseer state, shared with running children via `<base>/overseer.json`. */
export interface ActiveOverseer {
  readonly enabled: boolean;
  readonly judge: string;
}

export function writeLiveOverseer(
  base: string,
  state: Pick<OverseerState, "enabled" | "judge">,
): void {
  if (!fs.existsSync(base)) {
    return;
  }
  write(path.join(base, OVERSEER_STATE_FILE), {
    version: 1 as const,
    enabled: state.enabled,
    judge: state.judge,
    updatedAt: Date.now(),
  });
}

export function activeOverseer(base: string, launch: Pick<Launch, "overseer">): ActiveOverseer {
  const live = read(path.join(base, OVERSEER_STATE_FILE), overseerLiveStateSchema);
  if (live !== undefined) {
    return { enabled: live.enabled, judge: live.judge };
  }
  return {
    enabled: launch.overseer?.enabled === true,
    judge: launch.overseer?.judge ?? DEFAULT_OVERSEER_JUDGE,
  };
}

const PROMPT_SECTION = [
  "Overseer mode is active. Discuss architecture, verify existing language and package primitives before delegating, and keep direct edits to small scripts or surgical fixes.",
  "Pass `readOnly: true` for research, audit, or review children; editing children work freely in plain English without rigid file-glob contracts (prefer isolated worktrees).",
  'Children pause at natural checkpoints (early shape check, grounded skeptic findings with quoted hunks, tool-error loops, and pre-ship final diff). Answer pauses with `agent_runs` `action="continue"` (omit `prompt` to approve and resume, or include `prompt` to steer with corrections) or `action="stop"`.',
].join("\n");

export interface OverseerState {
  readonly enabled: boolean;
  readonly model: string;
  readonly judge: string;
}

export interface PreparedOverseerDelegation {
  readonly defaultModel?: string;
  readonly defaultThinking?: ThinkingLevel;
  readonly overseer?: OverseerLaunch;
}

const strOr = (v: unknown, fb: string): string =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : fb;

const normModel = (v: unknown, fb: string): string => {
  const s = strOr(v, fb);
  return s.toLowerCase() === "inherit" ? "inherit" : s;
};

const isThinking = (v: string): v is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(v);

export function splitModelSpec(model: string): {
  readonly defaultModel?: string;
  readonly defaultThinking?: ThinkingLevel;
} {
  if (model.toLowerCase() === "inherit") {
    return {};
  }
  const slash = model.indexOf("/");
  const colon = model.lastIndexOf(":");
  if (slash > 0 && colon > slash + 1) {
    const suffix = model.slice(colon + 1);
    if (isThinking(suffix)) {
      return { defaultModel: model.slice(0, colon), defaultThinking: suffix };
    }
  }
  return { defaultModel: model };
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n")
    .trim();
}

/** Captures recent owner messages from the parent session branch so the skeptic sees owner intent. */
export function captureOwnerContext(
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">,
): string | undefined {
  const branch: readonly unknown[] = sessionManager.getBranch();
  const messages: string[] = [];
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    if (entry.message.role !== "user") {
      continue;
    }
    const text = extractUserText(entry.message.content);
    if (text.length > 0) {
      messages.push(text);
    }
  }
  return messages.length === 0 ? undefined : messages.join("\n---\n");
}

function hostSettings(
  pi: Pick<ExtensionAPI, "getFlag" | "getSettings">,
): UnknownRecord | undefined {
  try {
    const res: unknown = pi.getSettings();
    return isRecord(res) ? res : undefined;
  } catch {
    return undefined;
  }
}

function defaults(pi: Pick<ExtensionAPI, "getFlag" | "getSettings">): OverseerState {
  const cfg = recordAt(recordAt(hostSettings(pi), "subagents"), "overseer");
  return {
    enabled: typeof cfg?.enabled === "boolean" ? cfg.enabled : pi.getFlag("overseer") === true,
    model: normModel(cfg?.model ?? cfg?.worker, DEFAULT_OVERSEER_MODEL),
    judge: strOr(cfg?.judge, DEFAULT_OVERSEER_JUDGE),
  };
}

function branchState(
  pi: Pick<ExtensionAPI, "getFlag" | "getSettings">,
  ctx: { readonly sessionManager: { readonly getBranch?: () => readonly unknown[] } },
): OverseerState {
  let cur = defaults(pi);
  const raw: unknown =
    typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
  if (!Array.isArray(raw)) {
    return cur;
  }
  for (const e of raw) {
    if (isRecord(e) && e.type === "custom" && e.customType === OVERSEER_ENTRY_TYPE) {
      const d = e.data;
      if (isRecord(d) && typeof d.enabled === "boolean") {
        cur = {
          enabled: d.enabled,
          model: normModel(d.model ?? d.worker, cur.model),
          judge: strOr(d.judge, cur.judge),
        };
      }
    }
  }
  return cur;
}

function completions(
  prefix: string,
  choices: readonly string[],
): Array<{ value: string; label: string }> | null {
  const p = prefix.trim().toLowerCase();
  const out = choices
    .filter((c) => c.toLowerCase().startsWith(p))
    .map((value) => ({ value, label: value }));
  return out.length > 0 ? out : null;
}

const validSpec = (s: string): boolean => {
  const i = s.indexOf("/");
  return i > 0 && i < s.length - 1 && !/\s/u.test(s);
};

export class OverseerController {
  private state: OverseerState = {
    enabled: false,
    model: DEFAULT_OVERSEER_MODEL,
    judge: DEFAULT_OVERSEER_JUDGE,
  };
  private readonly pi: ExtensionAPI;
  private readonly attachedBase: (() => string | undefined) | undefined;

  constructor(pi: ExtensionAPI, attachedBase?: () => string | undefined) {
    this.pi = pi;
    this.attachedBase = attachedBase;
  }

  get current(): OverseerState {
    return this.state;
  }

  publishLive(base: string): void {
    if (!this.shouldPublishOnSync(base)) {
      return;
    }
    writeLiveOverseer(base, this.state);
  }

  private shouldPublishOnSync(base: string): boolean {
    return (
      this.state.enabled ||
      this.state.judge !== DEFAULT_OVERSEER_JUDGE ||
      fs.existsSync(path.join(base, OVERSEER_STATE_FILE))
    );
  }

  private publishIfAttached(options: { readonly force: boolean; readonly notify: boolean }): void {
    const base = this.attachedBase?.();
    if (base === undefined) {
      return;
    }
    if (!options.force && !this.shouldPublishOnSync(base)) {
      return;
    }
    writeLiveOverseer(base, this.state);
    if (options.notify) {
      notifyInventory(base);
    }
  }

  private render(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus(
      "overseer",
      this.state.enabled ? ctx.ui.theme.fg("dim", "overseer") : undefined,
    );
  }

  private sync(ctx: ExtensionContext): void {
    this.state = branchState(this.pi, ctx);
    this.render(ctx);
    this.publishIfAttached({ force: false, notify: false });
  }

  private save(next: OverseerState, ctx: ExtensionContext): void {
    this.state = next;
    this.pi.appendEntry(OVERSEER_ENTRY_TYPE, { version: 1 as const, ...next });
    this.render(ctx);
    this.publishIfAttached({ force: true, notify: true });
  }

  private line(): string {
    return this.state.enabled
      ? `Overseer mode: on (model: ${this.state.model}, judge: ${this.state.judge})`
      : `Overseer mode: off (configured model: ${this.state.model}, judge: ${this.state.judge})`;
  }

  private onToggle(args: string, ctx: ExtensionCommandContext): void {
    const tok = args.trim().toLowerCase();
    if (tok === "status") {
      ctx.ui.notify(this.line(), "info");
      return;
    }
    if (tok !== "" && tok !== "on" && tok !== "off") {
      ctx.ui.notify("Usage: /overseer [on|off|status]", "warning");
      return;
    }
    this.save({ ...this.state, enabled: tok === "" ? !this.state.enabled : tok === "on" }, ctx);
    ctx.ui.notify(this.line(), "info");
  }

  private onModel(args: string, ctx: ExtensionCommandContext): void {
    const s = args.trim();
    const low = s.toLowerCase();
    if (s === "" || low === "status") {
      ctx.ui.notify(`Overseer model: ${this.state.model}`, "info");
      return;
    }
    if (low === "reset") {
      const model = defaults(this.pi).model;
      this.save({ ...this.state, model }, ctx);
      ctx.ui.notify(`Overseer model reset to ${model}`, "info");
      return;
    }
    if (low === "inherit") {
      this.save({ ...this.state, model: "inherit" }, ctx);
      ctx.ui.notify("Overseer model set to inherit", "info");
      return;
    }
    if (!validSpec(s)) {
      ctx.ui.notify(
        "Model must be 'inherit', provider/model[:thinking], 'reset', or 'status'.",
        "warning",
      );
      return;
    }
    this.save({ ...this.state, model: s }, ctx);
    ctx.ui.notify(`Overseer model set to ${s}`, "info");
  }

  private onJudge(args: string, ctx: ExtensionCommandContext): void {
    const s = args.trim();
    const low = s.toLowerCase();
    if (s === "" || low === "status") {
      ctx.ui.notify(`Overseer judge: ${this.state.judge}`, "info");
      return;
    }
    if (low === "reset") {
      const judge = defaults(this.pi).judge;
      this.save({ ...this.state, judge }, ctx);
      ctx.ui.notify(`Overseer judge reset to ${judge}`, "info");
      return;
    }
    if (low !== "auto" && low !== "off" && !validSpec(s)) {
      ctx.ui.notify(
        "Judge must be 'auto', 'off', provider/model[:thinking], 'reset', or 'status'.",
        "warning",
      );
      return;
    }
    const judge = low === "auto" || low === "off" ? low : s;
    this.save({ ...this.state, judge }, ctx);
    ctx.ui.notify(`Overseer judge set to ${judge}`, "info");
  }

  prepareDelegation(_input: DelegateInput): PreparedOverseerDelegation {
    if (!this.state.enabled) {
      return {};
    }
    return {
      ...splitModelSpec(this.state.model),
      overseer: { enabled: true, judge: this.state.judge },
    };
  }

  register(): void {
    this.pi.registerFlag("overseer", {
      description: "Start with overseer mode enabled",
      type: "boolean",
      default: false,
    });
    this.pi.on("session_start", (_e, ctx) => this.sync(ctx));
    this.pi.on("session_tree", (_e, ctx) => this.sync(ctx));
    this.pi.on("before_agent_start", (event) => {
      const { sections } = event.systemPromptOptions;
      if (this.state.enabled) {
        sections.overseer = PROMPT_SECTION;
      } else {
        delete sections.overseer;
      }
    });
    this.pi.registerCommand("overseer", {
      description: "Toggle or inspect overseer mode (/overseer [on|off|status])",
      getArgumentCompletions: (p) => completions(p, ["on", "off", "status"]),
      handler: (args, ctx) => {
        this.onToggle(args, ctx);
        return Promise.resolve();
      },
    });
    this.pi.registerCommand("overseer-model", {
      description:
        "Set or inspect the default overseer child model (/overseer-model <inherit|provider/model[:thinking]|reset|status>)",
      getArgumentCompletions: (p) => completions(p, ["inherit", "status", "reset"]),
      handler: (args, ctx) => {
        this.onModel(args, ctx);
        return Promise.resolve();
      },
    });
    this.pi.registerCommand("overseer-judge", {
      description:
        "Set or inspect the overseer skeptic model (/overseer-judge <auto|off|provider/model[:thinking]|reset|status>)",
      getArgumentCompletions: (p) =>
        completions(p, [
          "auto",
          "off",
          "status",
          "reset",
          "cloudflare-ai-gateway/claude-haiku-5-5",
          "cloudflare-ai-gateway/gpt-6-luna:medium",
          "google/gemini-3.8-flash:medium",
        ]),
      handler: (args, ctx) => {
        this.onJudge(args, ctx);
        return Promise.resolve();
      },
    });
  }
}
