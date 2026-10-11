import { isDeepStrictEqual } from "node:util";
import type { Usage as NativeUsage, JsonValue } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEventResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  OwnedRunView,
  SubagentExecutionResult,
  UsageContribution,
  ReadonlyInput,
  ObservedUsage,
} from "../../shared/types.ts";
import { SessionEntryCursor } from "../../shared/session-entries.ts";
import { createParentReceiptReader, type ParentReceipt } from "./parent-receipts.ts";
import { isRecord as isObject } from "../../shared/unknown.ts";
import { observedUsage, optionalString, requiredString } from "./child-message-validation.ts";
import { validateNativeUsage } from "./native-usage.ts";

const PREFIX = "subagent:";
const UNATTRIBUTED = "unattributed";

function billableChild(child: ReadonlyInput<OwnedRunView["children"][number]>): boolean {
  if (child.state === "live" || child.state === "unknown") {
    return false;
  }
  return child.result?.detached !== true && child.result?.accounting?.state !== "incomplete";
}

export function finalizedChildUsage(
  children: ReadonlyInput<OwnedRunView["children"]>,
  index?: number,
): UsageContribution[] {
  return children.flatMap((child) =>
    (index === undefined || child.index === index) && billableChild(child)
      ? (child.result?.usage.contributions ?? [])
      : [],
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item: unknown) => isJsonValue(item));
  }
  return isObject(value) && Object.values(value).every((item) => isJsonValue(item));
}
function serializeDetails(value: Readonly<Record<string, unknown>>): JsonValue {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonValue(serialized)) {
    throw new Error("Invalid serialized native usage details");
  }
  return serialized;
}

function readParentContributions(details: unknown): UsageContribution[] | undefined {
  if (!isObject(details) || !isObject(details.parentUsage)) {
    return;
  }
  const values: unknown = details.parentUsage.contributions;
  if (!Array.isArray(values)) {
    return;
  }
  return values.map((value: unknown) => {
    if (!isObject(value)) {
      throw new Error("Invalid subagent usage contribution");
    }
    const usage = observedUsage(value.usage);
    if (!usage) {
      throw new Error("Subagent usage contribution is unavailable");
    }
    return {
      id: requiredString(value.id, "contribution ID"),
      provider: optionalString(value.provider, "provider"),
      model: optionalString(value.model, "model"),
      usage,
    };
  });
}

function sumUsage(contributions: readonly UsageContribution[]): NativeUsage {
  const total: NativeUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const { usage } of contributions) {
    validateNativeUsage(usage);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      total[key] += usage[key];
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      total.cost[key] += usage.cost[key];
    }
    // These are subsets of output/cacheWrite, never additional total tokens.
    for (const key of ["reasoning", "cacheWrite1h"] as const) {
      if (usage[key] !== undefined) {
        total[key] = (total[key] ?? 0) + usage[key];
      }
    }
  }
  return total;
}

function sameUsage(a: ObservedUsage, b: ObservedUsage): boolean {
  return isDeepStrictEqual(
    { ...a, reasoning: a.reasoning, cacheWrite1h: a.cacheWrite1h },
    { ...b, reasoning: b.reasoning, cacheWrite1h: b.cacheWrite1h },
  );
}

function checkContribution(previous: UsageContribution | undefined, next: UsageContribution): void {
  if (
    previous &&
    ((previous.provider ?? UNATTRIBUTED) !== (next.provider ?? UNATTRIBUTED) ||
      (previous.model ?? UNATTRIBUTED) !== (next.model ?? UNATTRIBUTED) ||
      !sameUsage(previous.usage, next.usage))
  ) {
    throw new Error(`Conflicting subagent usage contribution: ${next.id}`);
  }
}

function uniqueContributions(contributions: readonly UsageContribution[]): UsageContribution[] {
  const unique = new Map<string, UsageContribution>();
  for (const contribution of contributions) {
    if (contribution.id.trim().length === 0) {
      throw new Error("Subagent usage requires a stable native contribution ID");
    }
    validateNativeUsage(contribution.usage);
    checkContribution(unique.get(contribution.id), contribution);
    unique.set(contribution.id, contribution);
  }
  return [...unique.values()];
}

type PublishedReceipt = ReadonlyInput<SessionEntry> | ParentReceipt;
class ReceiptIndexOwner {
  private readonly cursor = new SessionEntryCursor();
  private readonly received = new Map<string, UsageContribution>();
  private readonly toolNames: readonly string[];
  constructor(toolNames: readonly string[]) {
    this.toolNames = toolNames;
  }
  read(
    manager: ExtensionContext["sessionManager"],
    saved: Readonly<ReadonlyMap<string, PublishedReceipt>>,
  ): Readonly<ReadonlyMap<string, UsageContribution>> {
    const changes = this.cursor.read(manager);
    if (changes.reset) {
      this.received.clear();
    }
    for (const metadata of changes.entries) {
      if (metadata.type === "usage") {
        this.observeUsage(metadata);
      } else if (metadata.type === "message") {
        this.observeTool(metadata, manager, saved);
      }
    }
    return this.received;
  }
  private observeUsage(metadata: Extract<SessionEntry, { type: "usage" }>): void {
    const id =
      "contributionId" in metadata
        ? optionalString(metadata.contributionId, "contributionId")
        : undefined;
    if (id?.startsWith(PREFIX) === true) {
      this.received.set(id.slice(PREFIX.length), {
        id: id.slice(PREFIX.length),
        provider: metadata.provider,
        model: metadata.model,
        usage: metadata.usage,
      });
    }
  }
  private toolReceipt(
    metadata: Extract<SessionEntry, { type: "message" }>,
    manager: ExtensionContext["sessionManager"],
    saved: Readonly<ReadonlyMap<string, PublishedReceipt>>,
  ): PublishedReceipt {
    return (
      saved.get(metadata.id) ??
      ("details" in metadata.message && metadata.message.details !== undefined
        ? metadata
        : (manager.getEntry(metadata.id) ?? metadata))
    );
  }

  private observeTool(
    metadata: Extract<SessionEntry, { type: "message" }>,
    manager: ExtensionContext["sessionManager"],
    saved: Readonly<ReadonlyMap<string, PublishedReceipt>>,
  ): void {
    if (
      metadata.message.role !== "toolResult" ||
      !this.toolNames.includes(metadata.message.toolName)
    ) {
      return;
    }
    const entry = this.toolReceipt(metadata, manager, saved);
    if (entry.type !== "message" || entry.message.role !== "toolResult") {
      return;
    }
    const contributions = readParentContributions(entry.message.details);
    // Details/custom notifications alone do not prove native accounting ran.
    if (
      contributions !== undefined &&
      entry.message.usage &&
      sameUsage(entry.message.usage, sumUsage(contributions))
    ) {
      for (const contribution of contributions) {
        this.received.set(contribution.id, contribution);
      }
    }
  }
}
function unrecorded(
  contributions: readonly UsageContribution[],
  received: Readonly<ReadonlyMap<string, UsageContribution>>,
): UsageContribution[] {
  return uniqueContributions(contributions).filter((contribution) => {
    const previous = received.get(contribution.id);
    checkContribution(previous, contribution);
    return !previous;
  });
}

/**
 * Register once per extension instance. Attach only to finalized wait/execution
 * results, never inspection or streaming updates. Legacy tool aliases and saved
 * native usage entries still deduplicate old-session accounting.
 */
export interface ParentUsageRegistration {
  readonly isRecorded: (
    contributions: readonly UsageContribution[],
    ctx: ExtensionContext,
    saved: Readonly<ReadonlyMap<string, PublishedReceipt>>,
  ) => boolean;
  readonly attach: {
    (
      result: SubagentExecutionResult,
      contributions: readonly UsageContribution[],
      ctx: ExtensionContext,
    ): SubagentExecutionResult;
    (
      result: ReadonlyInput<SubagentExecutionResult>,
      contributions: readonly UsageContribution[],
      ctx: ExtensionContext,
    ): ReadonlyInput<SubagentExecutionResult>;
  };
}

export function registerParentUsage(
  pi: ExtensionAPI,
  toolNames: readonly string[],
): ParentUsageRegistration {
  const toolReceipts = createParentReceiptReader("inspect");
  const receipts = new ReceiptIndexOwner(toolNames);
  pi.on("message_end", (event, ctx): MessageEndEventResult | undefined => {
    const message = event.message;
    if (message.role !== "toolResult" || !toolNames.includes(message.toolName)) {
      return;
    }
    const details = message.details;
    const contributions = readParentContributions(details);
    if (!isObject(details) || contributions === undefined) {
      return;
    }
    const pending = unrecorded(
      contributions,
      receipts.read(ctx.sessionManager, toolReceipts.read(ctx.sessionManager.getSessionFile())),
    );
    const { usage: _usage, ...rest } = message;
    const { parentUsage: _parentUsage, ...restDetails } = details;
    // Public replacement hook: native emits/persists final tool messages serially,
    // even for concurrent tools. No in-memory reservation can outlive an aborted result.
    return {
      message: {
        ...rest,
        details: serializeDetails({
          ...restDetails,
          ...(pending.length > 0 ? { parentUsage: { contributions: pending } } : {}),
        }),
        ...(pending.length > 0 ? { usage: sumUsage(pending) } : {}),
      },
    };
  });

  // Attachment preserves the caller's content array, including its native mutable contract.
  function attach(
    result: SubagentExecutionResult,
    contributions: readonly UsageContribution[],
    ctx: ExtensionContext,
  ): SubagentExecutionResult;
  function attach(
    result: ReadonlyInput<SubagentExecutionResult>,
    contributions: readonly UsageContribution[],
    ctx: ExtensionContext,
  ): ReadonlyInput<SubagentExecutionResult>;
  function attach(
    result: ReadonlyInput<SubagentExecutionResult>,
    contributions: readonly UsageContribution[],
    ctx: ExtensionContext,
  ): ReadonlyInput<SubagentExecutionResult> {
    const { usage: _usage, ...rest } = result;
    const { parentUsage: _parentUsage, ...details } = result.details;
    if (contributions.length === 0) {
      return { ...rest, details };
    }
    // Required identity/conflict rejection precedes any optional host I/O.
    const saved = toolReceipts.read(ctx.sessionManager.getSessionFile());
    const pending = unrecorded(contributions, receipts.read(ctx.sessionManager, saved));
    // Intent only. Top-level usage is added at final message_end, immediately before native persistence.
    return {
      ...rest,
      details: {
        ...details,
        ...(pending.length > 0 ? { parentUsage: { contributions: pending } } : {}),
      },
    };
  }

  return {
    isRecorded(
      contributions: readonly UsageContribution[],
      ctx: ExtensionContext,
      saved: Readonly<ReadonlyMap<string, PublishedReceipt>>,
    ): boolean {
      return unrecorded(contributions, receipts.read(ctx.sessionManager, saved)).length === 0;
    },
    attach,
  };
}
