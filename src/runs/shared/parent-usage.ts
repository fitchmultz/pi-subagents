import { isDeepStrictEqual } from "node:util";
import type { Usage as NativeUsage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEventResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  Details,
  OwnedRunView,
  SubagentExecutionResult,
  UsageContribution,
} from "../../shared/types.ts";
import { SessionEntryCursor } from "../../shared/session-entries.ts";
import { createParentReceiptReader } from "./parent-receipts.ts";
import { validateNativeUsage } from "./native-usage.ts";

const PREFIX = "subagent:";
const UNATTRIBUTED = "unattributed";

export function finalizedChildUsage(
  children: OwnedRunView["children"],
  index?: number,
): UsageContribution[] {
  return children.flatMap((child) =>
    (index === undefined || child.index === index) &&
    child.state !== "live" &&
    child.state !== "unknown" &&
    !child.result?.detached &&
    child.result?.accounting?.state !== "incomplete"
      ? (child.result?.usage.contributions ?? [])
      : [],
  );
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
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      total[key] += usage[key];
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      total.cost[key] += usage.cost[key];
    }
    // These are subsets of output/cacheWrite, never additional total tokens.
    for (const key of ["reasoning", "cacheWrite1h"] as const) {
      if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
    }
  }
  return total;
}

function sameUsage(a: NativeUsage, b: NativeUsage): boolean {
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
    if (!contribution.id.trim()) {
      throw new Error("Subagent usage requires a stable native contribution ID");
    }
    validateNativeUsage(contribution.usage);
    checkContribution(unique.get(contribution.id), contribution);
    unique.set(contribution.id, contribution);
  }
  return [...unique.values()];
}

function createReceiptIndex(toolNames: readonly string[]) {
  const cursor = new SessionEntryCursor();
  const received = new Map<string, UsageContribution>();
  return (
    manager: ExtensionContext["sessionManager"],
    saved: ReadonlyMap<string, SessionEntry>,
  ) => {
    const changes = cursor.read(manager);
    if (changes.reset) {
      received.clear();
    }
    for (const metadata of changes.entries) {
      if (metadata.type === "usage") {
        const id = (metadata as typeof metadata & { contributionId?: string }).contributionId;
        if (id?.startsWith(PREFIX)) {
          received.set(id.slice(PREFIX.length), {
            id: id.slice(PREFIX.length),
            provider: metadata.provider,
            model: metadata.model,
            usage: metadata.usage,
          });
        }
        continue;
      }
      if (
        metadata.type !== "message" ||
        metadata.message.role !== "toolResult" ||
        !toolNames.includes(metadata.message.toolName)
      ) {
        continue;
      }
      const entry =
        saved.get(metadata.id) ??
        (metadata.message.details !== undefined
          ? metadata
          : (manager.getEntry(metadata.id) ?? metadata));
      if (entry.type !== "message" || entry.message.role !== "toolResult") {
        continue;
      }
      const contributions = (entry.message.details as Details | undefined)?.parentUsage
        ?.contributions;
      // Details/custom notifications alone are never evidence that native accounting ran.
      if (
        Array.isArray(contributions) &&
        entry.message.usage &&
        sameUsage(entry.message.usage, sumUsage(contributions))
      ) {
        for (const contribution of contributions) {
          received.set(contribution.id, contribution);
        }
      }
    }
    return received;
  };
}

function unrecorded(
  contributions: readonly UsageContribution[],
  received: Map<string, UsageContribution>,
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
export function registerParentUsage(pi: ExtensionAPI, toolNames: readonly string[]) {
  const toolReceipts = createParentReceiptReader("inspect");
  const receipts = createReceiptIndex(toolNames);
  pi.on("message_end", (event, ctx): MessageEndEventResult | undefined => {
    const message = event.message;
    if (message.role !== "toolResult" || !toolNames.includes(message.toolName)) {
      return;
    }
    const details = message.details as Details | undefined;
    if (!details?.parentUsage) {
      return;
    }
    const pending = unrecorded(
      details.parentUsage.contributions,
      receipts(ctx.sessionManager, toolReceipts.read(ctx.sessionManager.getSessionFile())),
    );
    const { usage: _usage, ...rest } = message;
    const { parentUsage: _parentUsage, ...restDetails } = details;
    // Public replacement hook: native emits/persists final tool messages serially,
    // even for concurrent tools. No in-memory reservation can outlive an aborted result.
    return {
      message: {
        ...rest,
        details: JSON.parse(
          JSON.stringify({
            ...restDetails,
            ...(pending.length ? { parentUsage: { contributions: pending } } : {}),
          }),
        ),
        ...(pending.length ? { usage: sumUsage(pending) } : {}),
      },
    };
  });

  return {
    isRecorded(
      contributions: readonly UsageContribution[],
      ctx: ExtensionContext,
      saved: ReadonlyMap<string, SessionEntry>,
    ): boolean {
      return unrecorded(contributions, receipts(ctx.sessionManager, saved)).length === 0;
    },
    attach(
      result: SubagentExecutionResult,
      contributions: readonly UsageContribution[],
      ctx: ExtensionContext,
    ): SubagentExecutionResult {
      const { usage: _usage, ...rest } = result;
      const { parentUsage: _parentUsage, ...details } = result.details;
      if (!contributions.length) {
        return { ...rest, details };
      }
      // Required identity/conflict rejection precedes any optional host I/O.
      const saved = toolReceipts.read(ctx.sessionManager.getSessionFile());
      const pending = unrecorded(contributions, receipts(ctx.sessionManager, saved));
      // Intent only. Top-level usage is added at final message_end, immediately before native persistence.
      return {
        ...rest,
        details: {
          ...details,
          ...(pending.length ? { parentUsage: { contributions: pending } } : {}),
        },
      };
    },
  };
}
