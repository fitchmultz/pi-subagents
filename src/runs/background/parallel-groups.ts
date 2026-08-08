import type { AsyncParallelGroupStatus } from "../../shared/types.ts";

function isValidParallelGroup(group: unknown, stepCount: number, chainStepCount: number): group is AsyncParallelGroupStatus {
	if (typeof group !== "object" || group === null) return false;
	const { start, count, stepIndex } = group as Partial<AsyncParallelGroupStatus>;
	return typeof start === "number"
		&& typeof count === "number"
		&& typeof stepIndex === "number"
		&& Number.isInteger(start)
		&& Number.isInteger(count)
		&& Number.isInteger(stepIndex)
		&& start >= 0
		&& count > 0
		&& stepIndex >= 0
		&& stepIndex < chainStepCount
		&& start + count <= stepCount;
}

export function normalizeParallelGroups(groups: unknown, stepCount: number, chainStepCount: number): AsyncParallelGroupStatus[] {
	if (!Array.isArray(groups)) return [];
	const sorted = groups
		.filter((group): group is AsyncParallelGroupStatus => isValidParallelGroup(group, stepCount, chainStepCount))
		.sort((left, right) => left.stepIndex - right.stepIndex || left.start - right.start);
	const normalized: AsyncParallelGroupStatus[] = [];
	const logicalSteps = new Set<number>();
	for (const group of sorted) {
		if (logicalSteps.has(group.stepIndex) || normalized.some((existing) => group.start < existing.start + existing.count && existing.start < group.start + group.count)) continue;
		logicalSteps.add(group.stepIndex);
		normalized.push(group);
	}
	return normalized;
}

export function flatToLogicalStepIndex(flatIndex: number, chainStepCount: number, groups: AsyncParallelGroupStatus[]): number {
	let logicalIndex = 0;
	let cursor = 0;
	for (const group of groups) {
		while (cursor < group.start && logicalIndex < chainStepCount) {
			if (cursor === flatIndex) return logicalIndex;
			cursor++;
			logicalIndex++;
		}
		if (flatIndex >= group.start && flatIndex < group.start + group.count) return group.stepIndex;
		cursor = group.start + group.count;
		logicalIndex = group.stepIndex + 1;
	}
	while (cursor <= flatIndex && logicalIndex < chainStepCount) {
		if (cursor === flatIndex) return logicalIndex;
		cursor++;
		logicalIndex++;
	}
	return Math.max(0, chainStepCount - 1);
}
