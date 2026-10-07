import type { HistoryStore, SourceRow } from "./store.ts";
import { compactEntry, visibleId } from "./preview.ts";
import { object, objects, string } from "./values.ts";
import { text } from "./rows.ts";

export interface IngestRecord {
  readonly value: Readonly<Record<string, unknown>>;
  readonly start: number;
  readonly end: number;
  readonly digest: string;
}
function model(value: Readonly<Record<string, unknown>>): string | null {
  if (value.type === "model_change" && typeof value.modelId === "string") {
    return `${string(value.provider) ?? "undefined"}/${value.modelId}`;
  }
  const message = object(value.message);
  if (
    value.type === "message" &&
    message.role === "assistant" &&
    typeof message.model === "string"
  ) {
    return `${string(message.provider) ?? "undefined"}/${message.model}`;
  }
  return null;
}
function messageFacts(
  value: Readonly<Record<string, unknown>>,
): readonly [string | null, number, string | null, string | null, string | null] {
  const message = object(value.message);
  const assistantText =
    message.role === "assistant" &&
    objects(message.content).some(
      (part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0,
    );
  const humanId = object(object(value.details).message).id;
  return [
    string(message.role) ?? null,
    assistantText ? 1 : 0,
    value.type === "custom_message" && value.customType === "subagent-human-message"
      ? (string(humanId) ?? null)
      : null,
    model(value),
    value.type === "thinking_level_change" ? (string(value.thinkingLevel) ?? null) : null,
  ];
}
function parentId(
  store: Readonly<HistoryStore>,
  source: SourceRow,
  value: Readonly<Record<string, unknown>>,
): string | null {
  if (source.format_version !== 1) {
    return string(value.parentId) ?? null;
  }
  const previous = store.get(
    "SELECT id FROM entries WHERE source_id=? AND generation=? AND published=1 ORDER BY start DESC LIMIT 1",
    source.id,
    source.generation,
  );
  return previous ? text(previous, "id") : null;
}
/** Preview and ancestry facts are staged first, never query-visible before the final publication transaction. */
export function stageEntry(
  store: Readonly<HistoryStore>,
  source: SourceRow,
  record: IngestRecord,
): number {
  const value = record.value;
  const nativeId = string(value.id) ?? null;
  const id = nativeId ?? `legacy-${record.start}`;
  const parent = parentId(store, source, value);
  const timestamp =
    typeof value.timestamp === "number"
      ? value.timestamp
      : Date.parse(string(value.timestamp) ?? "");
  const preview = { ...compactEntry(value), id, parentId: parent };
  const [role, assistantText, humanId, configurationModel, thinking] = messageFacts(value);
  return Number(
    store.run(
      "INSERT INTO entries(source_id,generation,id,native_id,parent_id,start,end,digest,timestamp,type,preview,role,assistant_text,visible_id,human_id,configuration_model,configuration_thinking) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      source.id,
      source.generation,
      id,
      nativeId,
      parent,
      record.start,
      record.end,
      record.digest,
      Number.isFinite(timestamp) ? timestamp : null,
      string(value.type) ?? "unknown",
      JSON.stringify(preview),
      role,
      assistantText,
      visibleId(value, id),
      humanId,
      configurationModel,
      thinking,
    ).lastInsertRowid,
  );
}
export function publishTools(
  store: Readonly<HistoryStore>,
  source: SourceRow,
  rowid: number,
  value: Readonly<Record<string, unknown>>,
): void {
  const message = object(value.message);
  for (const part of objects(message.content)) {
    if (part.type === "toolCall" && typeof part.id === "string") {
      store.run(
        "INSERT INTO tools VALUES (?,?,?,?,?)",
        rowid,
        source.id,
        source.generation,
        part.id,
        "call",
      );
    }
  }
  if (message.role === "toolResult" && typeof message.toolCallId === "string") {
    store.run(
      "INSERT INTO tools VALUES (?,?,?,?,?)",
      rowid,
      source.id,
      source.generation,
      message.toolCallId,
      "result",
    );
  }
}
