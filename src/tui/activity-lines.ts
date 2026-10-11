import { formatDuration, shortenPath } from "../shared/formatters.ts";
import { hasText, nonemptyText } from "./text-values.ts";
interface ActivityInput {
  readonly currentTool?: string;
  readonly currentToolStartedAt?: number;
  readonly currentPath?: string;
  readonly turnCount?: number;
  readonly toolCount?: number;
}
function toolActivity(input: ActivityInput, now?: number): string | undefined {
  if (!hasText(input.currentTool)) {
    return;
  }
  if (input.currentToolStartedAt === undefined || now === undefined) {
    return input.currentTool;
  }
  return `${input.currentTool} ${formatDuration(Math.max(0, now - input.currentToolStartedAt))}`;
}
/** Activity facts are shared by job, step and nested rows; each caller owns status/outcome policy. */
export function activityFacts(input: ActivityInput, now?: number, counts = true): string[] {
  const facts: string[] = [],
    tool = toolActivity(input, now);
  if (tool !== undefined) {
    facts.push(tool);
  }
  if (hasText(input.currentPath)) {
    facts.push(shortenPath(input.currentPath));
  }
  if (counts && input.turnCount !== undefined) {
    facts.push(`${input.turnCount} turns`);
  }
  if (counts && input.toolCount !== undefined) {
    facts.push(`${input.toolCount} tools`);
  }
  return facts;
}
export function joinActivity(facts: readonly string[], activity?: string, fallback = ""): string {
  const prefix = hasText(activity) ? [activity] : [];
  return nonemptyText([...prefix, ...facts].join(" · ")) ?? fallback;
}
