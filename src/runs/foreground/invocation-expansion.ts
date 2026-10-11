import { isParallelStep, type ChainStep } from "../../shared/settings.ts";
import type { SubagentExecutionResult } from "../../shared/types.ts";
import type { SubagentParamsLike } from "./subagent-params.ts";

function expandTasks<T extends { readonly count?: number }>(
  tasks: readonly T[],
  prefix: string,
): Omit<T, "count">[] {
  const expanded: Omit<T, "count">[] = [];
  for (const [index, task] of tasks.entries()) {
    const count: unknown = task.count;
    if (
      count !== undefined &&
      (typeof count !== "number" || !Number.isInteger(count) || count < 1)
    ) {
      throw new Error(`${prefix}[${index}].count must be an integer >= 1`);
    }
    const { count: _count, ...concrete } = task;
    for (let repeat = 0; repeat < (typeof count === "number" ? count : 1); repeat++) {
      expanded.push({ ...concrete });
    }
  }
  return expanded;
}
function expandChain(chain: readonly ChainStep[]): ChainStep[] {
  return chain.map((step, index) => {
    if (!isParallelStep(step)) {
      return step;
    }
    const parallel = expandTasks(step.parallel, `chain[${index}].parallel`);
    return { ...step, parallel };
  });
}
export function normalizeRepeatedParallelCounts(params: SubagentParamsLike): {
  params?: SubagentParamsLike;
  error?: SubagentExecutionResult;
} {
  try {
    if (params.tasks) {
      return { params: { ...params, tasks: expandTasks(params.tasks, "tasks") } };
    }
    if (params.chain) {
      return { params: { ...params, chain: expandChain(params.chain) } };
    }
    return { params };
  } catch (error) {
    const mode = params.tasks ? "parallel" : "chain";
    return {
      error: {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : "Task expansion failed." },
        ],
        details: { mode, results: [], ...(params.context === "fork" ? { context: "fork" } : {}) },
      },
    };
  }
}
