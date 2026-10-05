import type { ResolvedStepBehavior } from "./types/workflow.ts";

export function resolveTaskTextForFileUpdatePolicy(
  task: string | undefined,
  originalTask?: string,
): string | undefined {
  if (task === undefined || task.length === 0) {
    return originalTask;
  }
  return originalTask !== undefined && originalTask.length > 0
    ? task.replaceAll("{task}", () => originalTask)
    : task;
}
export function taskDisallowsFileUpdates(task: string | undefined): boolean {
  if (task === undefined || task.length === 0) {
    return false;
  }
  return (
    /\breview[- ]only\b/i.test(task) ||
    /\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task) ||
    /\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task) ||
    /\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task) ||
    /\bleave\s+files?\s+unchanged\b/i.test(task)
  );
}
export function suppressProgressForReadOnlyTask(
  behavior: ResolvedStepBehavior,
  task: string | undefined,
  originalTask?: string,
): ResolvedStepBehavior {
  const policyTask = resolveTaskTextForFileUpdatePolicy(task, originalTask);
  return behavior.progress && taskDisallowsFileUpdates(policyTask)
    ? { ...behavior, progress: false }
    : behavior;
}
