import type { HistoryConfiguration, HistoryRunRow, ReadonlyInput } from "../shared/types.ts";
import { formatModelThinking } from "../shared/formatters.ts";
import { readableText } from "./agent-history.ts";
import { hasText } from "./text-values.ts";
type Child = ReadonlyInput<HistoryRunRow["children"][number]>;
type Model = Readonly<Pick<HistoryConfiguration, "model" | "thinking">>;
interface Selection {
  readonly value?: Model;
  readonly source: "selected" | "session" | "saved";
}
export const unavailableModel = {
  summary: "model unavailable",
  details: "Model unavailable. No provider/model was recorded for this assignment.",
};
function recordedModel(
  child: Child,
  native: HistoryConfiguration | undefined,
): HistoryConfiguration | undefined {
  if (child.state === "live") {
    return native;
  }
  const saved = child.savedConfiguration ?? child.launch;
  return hasText(native?.model) ? { ...saved, ...native } : saved;
}
function fallbackModel(child: Child, native: HistoryConfiguration | undefined): Model | undefined {
  if (child.state === "live" && hasText(native?.model)) {
    return native;
  }
  return hasText(child.launch?.model) ? child.launch : child.result;
}
function savedModelIsCurrent(child: Child, recorded: HistoryConfiguration): boolean {
  const selected = child.modelSelection;
  if (selected?.modelStartedAt === undefined) {
    return child.state !== "live";
  }
  return (recorded.modelRecordedAt ?? 0) > selected.modelStartedAt;
}
function modelSelection(child: Child, native: HistoryConfiguration | undefined): Selection {
  const recorded = recordedModel(child, native),
    selected = child.modelSelection;
  if (hasText(recorded?.model) && savedModelIsCurrent(child, recorded)) {
    return { value: recorded, source: child.state === "live" ? "session" : "saved" };
  }
  return hasText(selected?.model)
    ? { value: selected, source: "selected" }
    : { value: fallbackModel(child, native), source: "saved" };
}
function formattedModel(value: Model | undefined): string | undefined {
  return hasText(value?.model)
    ? readableText(formatModelThinking(value.model, value.thinking))
    : undefined;
}
export function agentModel(
  child: Child,
  native?: HistoryConfiguration,
): { readonly summary: string; readonly details: string } {
  if (child.identityUnavailable === true) {
    return unavailableModel;
  }
  const selection = modelSelection(child, native),
    formatted = formattedModel(selection.value);
  if (formatted === undefined) {
    return unavailableModel;
  }
  const selected = formattedModel(child.modelSelection),
    saved = formattedModel(native);
  const details = [`Model (${selection.source}): ${formatted}`];
  if (selected !== undefined && selected !== formatted) {
    details.push(`Selected model: ${selected}`);
  }
  if (child.state === "live" && saved !== undefined && saved !== formatted) {
    details.push(`Last saved session model (may precede this attempt): ${saved}`);
  }
  return {
    summary: selection.source === "session" ? formatted : `${selection.source}: ${formatted}`,
    details: details.join("\n"),
  };
}
