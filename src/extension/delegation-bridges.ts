import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  normalizeSubagentParamsLike,
  type createSubagentExecutor,
} from "../runs/foreground/subagent-executor.ts";
import type { IntercomEventBus } from "../shared/types.ts";
import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.ts";

interface DelegationBridges {
  readonly slash: ReturnType<typeof registerSlashSubagentBridge>;
  readonly template: ReturnType<typeof registerPromptTemplateDelegationBridge>;
}

/** Translate the two existing event protocols into the canonical application invocation. */
export function registerDelegationBridges(input: {
  readonly events: IntercomEventBus;
  readonly getContext: () => ExtensionContext | null;
  readonly executor: Readonly<ReturnType<typeof createSubagentExecutor>>;
}): DelegationBridges {
  const slash = registerSlashSubagentBridge({
    events: input.events,
    getContext: input.getContext,
    execute: (request) => input.executor.execute(request),
  });
  const template = registerPromptTemplateDelegationBridge({
    events: input.events,
    getContext: input.getContext,
    execute: async ({ request, signal, ctx, onUpdate }) => {
      const params =
        request.tasks !== undefined && request.tasks.length > 0
          ? {
              tasks: request.tasks,
              context: request.context,
              cwd: request.cwd,
              worktree: request.worktree,
              async: false,
              clarify: false,
            }
          : {
              agent: request.agent,
              task: request.task,
              context: request.context,
              cwd: request.cwd,
              model: request.model,
              async: false,
              clarify: false,
            };
      return input.executor.execute({
        toolCallId: request.requestId,
        params: normalizeSubagentParamsLike(params),
        signal,
        onUpdate,
        ctx,
      });
    },
  });
  return { slash, template };
}
