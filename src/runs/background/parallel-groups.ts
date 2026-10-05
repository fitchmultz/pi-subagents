import type { AsyncParallelGroupStatus } from "../../shared/types.ts";

function numericParallelGroup(group: unknown): group is AsyncParallelGroupStatus {
  if (
    typeof group !== "object" ||
    group === null ||
    !("start" in group && "count" in group && "stepIndex" in group)
  ) {
    return false;
  }
  return (
    typeof group.start === "number" &&
    typeof group.count === "number" &&
    typeof group.stepIndex === "number" &&
    [group.start, group.count, group.stepIndex].every(Number.isInteger)
  );
}

function isValidParallelGroup(
  group: unknown,
  stepCount: number,
  chainStepCount: number,
): group is AsyncParallelGroupStatus {
  if (!numericParallelGroup(group)) {
    return false;
  }
  const { start, count, stepIndex } = group;
  return (
    start >= 0 &&
    count >= 0 &&
    stepIndex >= 0 &&
    stepIndex < chainStepCount &&
    start + count <= stepCount
  );
}

export function normalizeParallelGroups(
  groups: unknown,
  stepCount: number,
  chainStepCount: number,
): AsyncParallelGroupStatus[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  const candidates: readonly unknown[] = groups;
  const sorted = candidates
    .filter((group): group is AsyncParallelGroupStatus =>
      isValidParallelGroup(group, stepCount, chainStepCount),
    )
    .sort((left, right) => {
      const logical = left.stepIndex - right.stepIndex;
      return logical === 0 ? left.start - right.start : logical;
    });
  const normalized: AsyncParallelGroupStatus[] = [];
  const logicalSteps = new Set<number>();
  for (const group of sorted) {
    if (
      logicalSteps.has(group.stepIndex) ||
      normalized.some(
        (existing) =>
          group.start < existing.start + existing.count &&
          existing.start < group.start + group.count,
      )
    ) {
      continue;
    }
    logicalSteps.add(group.stepIndex);
    normalized.push(group);
  }
  return normalized;
}

export function flatToLogicalStepIndex(
  flatIndex: number,
  chainStepCount: number,
  groups: readonly Readonly<AsyncParallelGroupStatus>[],
): number {
  let logicalIndex = 0;
  let cursor = 0;
  for (const group of groups) {
    while (cursor < group.start && logicalIndex < chainStepCount) {
      if (cursor === flatIndex) {
        return logicalIndex;
      }
      cursor++;
      logicalIndex++;
    }
    if (flatIndex >= group.start && flatIndex < group.start + group.count) {
      return group.stepIndex;
    }
    cursor = group.start + group.count;
    logicalIndex = group.stepIndex + 1;
  }
  while (cursor <= flatIndex && logicalIndex < chainStepCount) {
    if (cursor === flatIndex) {
      return logicalIndex;
    }
    cursor++;
    logicalIndex++;
  }
  return Math.max(0, chainStepCount - 1);
}
