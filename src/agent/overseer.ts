import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isRecord, recordAt, type UnknownRecord } from "../shared/unknown.ts";
import { THINKING_LEVELS, type DelegationContract, type OverseerLaunch } from "./contracts.ts";
import { normalizeDelegationContract } from "./overseer-scope.ts";
import type { DelegateInput } from "./tool-schemas.ts";

export const OVERSEER_ENTRY_TYPE = "subagents-overseer";
export const DEFAULT_OVERSEER_WORKER = "google/gemini-4-hydrogen:high";
export const DEFAULT_OVERSEER_JUDGE = "auto";

const OVERSEER_PROMPT_SECTION = [
  "Overseer mode is active. Discuss architecture, verify existing language and package primitives before delegating, and keep direct edits to small scripts or surgical fixes.",
  "When delegating via `delegate`, always supply `contract` (`scope: []` to disable edit tools for recon/review, or allowed relative `scope` edit paths plus `verification`, `requiredPrimitives`, `nonGoals`, and `baseBranch` for implementation; shell commands are not OS-sandboxed). Omitted `model` uses the configured overseer worker.",
  "You are accountable for every child output: handle mid-run escalations promptly and inspect the real git diff against the contract before finishing.",
].join("\n");

export interface OverseerState {
  readonly enabled: boolean;
  readonly worker: string;
  readonly judge: string;
}

interface PersistedOverseerEntry {
  readonly version: 1;
  readonly enabled: boolean;
  readonly worker: string;
  readonly judge: string;
}

export interface PreparedOverseerDelegation {
  readonly defaultModel?: string;
  readonly defaultThinking?: ThinkingLevel;
  readonly contract?: DelegationContract;
  readonly overseer?: OverseerLaunch;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function splitWorkerSpec(worker: string): {
  readonly defaultModel: string;
  readonly defaultThinking?: ThinkingLevel;
} {
  const slash = worker.indexOf("/");
  const colon = worker.lastIndexOf(":");
  if (slash > 0 && colon > slash + 1) {
    const suffix = worker.slice(colon + 1);
    if (isThinkingLevel(suffix)) {
      return { defaultModel: worker.slice(0, colon), defaultThinking: suffix };
    }
  }
  return { defaultModel: worker };
}

function readHostSettings(
  pi: Pick<ExtensionAPI, "getFlag" | "getSettings">,
): UnknownRecord | undefined {
  try {
    const result: unknown = pi.getSettings();
    return isRecord(result) ? result : undefined;
  } catch {
    // Loader-only hosts invoke registered handlers without binding ExtensionRuntime actions.
    return undefined;
  }
}

function configuredDefaults(pi: Pick<ExtensionAPI, "getFlag" | "getSettings">): OverseerState {
  const overseer = recordAt(recordAt(readHostSettings(pi), "subagents"), "overseer");
  const flagEnabled = pi.getFlag("overseer") === true;
  return {
    enabled: typeof overseer?.enabled === "boolean" ? overseer.enabled : flagEnabled,
    worker: nonEmptyString(overseer?.worker, DEFAULT_OVERSEER_WORKER),
    judge: nonEmptyString(overseer?.judge, DEFAULT_OVERSEER_JUDGE),
  };
}

function readEntryState(data: unknown, fallback: OverseerState): OverseerState | undefined {
  if (!isRecord(data) || typeof data.enabled !== "boolean") {
    return undefined;
  }
  return {
    enabled: data.enabled,
    worker: nonEmptyString(data.worker, fallback.worker),
    judge: nonEmptyString(data.judge, fallback.judge),
  };
}

function reconstructBranchState(
  pi: Pick<ExtensionAPI, "getFlag" | "getSettings">,
  ctx: Pick<ExtensionContext, "sessionManager">,
): OverseerState {
  let current = configuredDefaults(pi);
  const rawEntries: unknown = ctx.sessionManager.getBranch();
  if (!Array.isArray(rawEntries)) {
    return current;
  }
  for (const entry of rawEntries) {
    if (isRecord(entry) && entry.type === "custom" && entry.customType === OVERSEER_ENTRY_TYPE) {
      current = readEntryState(entry.data, current) ?? current;
    }
  }
  return current;
}

function shortModelLabel(reference: string): string {
  const slash = reference.indexOf("/");
  const withoutProvider = slash >= 0 ? reference.slice(slash + 1) : reference;
  const colon = withoutProvider.indexOf(":");
  return colon >= 0 ? withoutProvider.slice(0, colon) : withoutProvider;
}

function prefixCompletions(
  prefix: string,
  choices: readonly string[],
): Array<{ value: string; label: string }> | null {
  const trimmed = prefix.trim().toLowerCase();
  const matches = choices
    .filter((choice) => choice.toLowerCase().startsWith(trimmed))
    .map((value) => ({ value, label: value }));
  return matches.length > 0 ? matches : null;
}

function validModelSpec(spec: string): boolean {
  const slash = spec.indexOf("/");
  return slash > 0 && slash < spec.length - 1 && !/\s/u.test(spec);
}

export class OverseerController {
  private state: OverseerState;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.state = {
      enabled: false,
      worker: DEFAULT_OVERSEER_WORKER,
      judge: DEFAULT_OVERSEER_JUDGE,
    };
  }

  get current(): OverseerState {
    return this.state;
  }

  private renderStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return;
    }
    if (!this.state.enabled) {
      ctx.ui.setStatus("overseer", undefined);
      return;
    }
    ctx.ui.setStatus(
      "overseer",
      ctx.ui.theme.fg("dim", `overseer: ${shortModelLabel(this.state.worker)}`),
    );
  }

  private syncFromBranch(ctx: ExtensionContext): void {
    this.state = reconstructBranchState(this.pi, ctx);
    this.renderStatus(ctx);
  }

  private persist(next: OverseerState, ctx: ExtensionContext): void {
    this.state = next;
    const entry: PersistedOverseerEntry = {
      version: 1,
      enabled: next.enabled,
      worker: next.worker,
      judge: next.judge,
    };
    this.pi.appendEntry(OVERSEER_ENTRY_TYPE, entry);
    this.renderStatus(ctx);
  }

  private statusLine(): string {
    return this.state.enabled
      ? `Overseer mode: on (worker: ${this.state.worker}, judge: ${this.state.judge})`
      : `Overseer mode: off (worker: ${this.state.worker}, judge: ${this.state.judge})`;
  }

  private handleToggle(args: string, ctx: ExtensionCommandContext): void {
    const token = args.trim().toLowerCase();
    if (token === "status") {
      ctx.ui.notify(this.statusLine(), "info");
      return;
    }
    if (token !== "" && token !== "on" && token !== "off") {
      ctx.ui.notify("Usage: /overseer [on|off|status]", "warning");
      return;
    }
    const enabled = token === "" ? !this.state.enabled : token === "on";
    this.persist({ ...this.state, enabled }, ctx);
    ctx.ui.notify(this.statusLine(), "info");
  }

  private handleWorker(args: string, ctx: ExtensionCommandContext): void {
    const trimmed = args.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "status") {
      ctx.ui.notify(`Overseer worker: ${this.state.worker}`, "info");
      return;
    }
    if (trimmed.toLowerCase() === "reset") {
      const defaults = configuredDefaults(this.pi);
      this.persist({ ...this.state, worker: defaults.worker }, ctx);
      ctx.ui.notify(`Overseer worker reset to ${defaults.worker}`, "info");
      return;
    }
    if (!validModelSpec(trimmed)) {
      ctx.ui.notify("Worker must be provider/model[:thinking], 'reset', or 'status'.", "warning");
      return;
    }
    this.persist({ ...this.state, worker: trimmed }, ctx);
    ctx.ui.notify(`Overseer worker set to ${trimmed}`, "info");
  }

  private handleJudge(args: string, ctx: ExtensionCommandContext): void {
    const trimmed = args.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "status") {
      ctx.ui.notify(`Overseer judge: ${this.state.judge}`, "info");
      return;
    }
    const lower = trimmed.toLowerCase();
    if (lower === "reset") {
      const defaults = configuredDefaults(this.pi);
      this.persist({ ...this.state, judge: defaults.judge }, ctx);
      ctx.ui.notify(`Overseer judge reset to ${defaults.judge}`, "info");
      return;
    }
    if (lower !== "auto" && lower !== "off" && !validModelSpec(trimmed)) {
      ctx.ui.notify(
        "Judge must be 'auto', 'off', provider/model, 'reset', or 'status'.",
        "warning",
      );
      return;
    }
    const judge = lower === "auto" || lower === "off" ? lower : trimmed;
    this.persist({ ...this.state, judge }, ctx);
    ctx.ui.notify(`Overseer judge set to ${judge}`, "info");
  }

  prepareDelegation(input: DelegateInput): PreparedOverseerDelegation {
    const contract =
      input.contract === undefined ? undefined : normalizeDelegationContract(input.contract);
    if (!this.state.enabled) {
      return contract === undefined ? {} : { contract };
    }
    if (contract === undefined) {
      throw new Error(
        "Overseer mode requires contract ({ scope, verification?, requiredPrimitives?, nonGoals?, baseBranch? }); use scope: [] when file edits are not needed.",
      );
    }
    return {
      ...splitWorkerSpec(this.state.worker),
      contract,
      overseer: { enabled: true, judge: this.state.judge },
    };
  }

  register(): void {
    this.pi.registerFlag("overseer", {
      description: "Start with overseer mode enabled",
      type: "boolean",
      default: false,
    });
    this.pi.on("session_start", (_event, ctx) => {
      this.syncFromBranch(ctx);
    });
    this.pi.on("session_tree", (_event, ctx) => {
      this.syncFromBranch(ctx);
    });
    this.pi.on("before_agent_start", (event) => {
      const { sections } = event.systemPromptOptions;
      if (this.state.enabled) {
        sections.overseer = OVERSEER_PROMPT_SECTION;
      } else {
        delete sections.overseer;
      }
    });
    this.pi.registerCommand("overseer", {
      description: "Toggle or inspect overseer mode (/overseer [on|off|status])",
      getArgumentCompletions: (prefix) => prefixCompletions(prefix, ["on", "off", "status"]),
      handler: (args, ctx) => {
        this.handleToggle(args, ctx);
        return Promise.resolve();
      },
    });
    this.pi.registerCommand("overseer-worker", {
      description:
        "Set or inspect the default overseer worker model (/overseer-worker <provider/model[:thinking]|reset|status>)",
      getArgumentCompletions: (prefix) =>
        prefixCompletions(prefix, ["status", "reset", DEFAULT_OVERSEER_WORKER]),
      handler: (args, ctx) => {
        this.handleWorker(args, ctx);
        return Promise.resolve();
      },
    });
    this.pi.registerCommand("overseer-judge", {
      description:
        "Set or inspect the overseer decision judge (/overseer-judge <auto|off|provider/model|reset|status>)",
      getArgumentCompletions: (prefix) =>
        prefixCompletions(prefix, ["auto", "off", "status", "reset", "google/gemini-decision-1"]),
      handler: (args, ctx) => {
        this.handleJudge(args, ctx);
        return Promise.resolve();
      },
    });
  }
}
