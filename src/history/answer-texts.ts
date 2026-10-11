import { stripTerminalSequences } from "../shared/native-tui.ts";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import { exactTextDigest } from "./store.ts";
import { object, objects, string } from "./values.ts";

/** Exact matches never use previews. Oversized selected text has no fingerprint. */
export class AnswerTexts {
  private readonly fields = new Map<number, string>();
  private length = 0;
  private unavailable = false;
  write(keys: readonly (string | number)[], text: string): void {
    if (
      this.unavailable ||
      keys.length !== 4 ||
      keys[0] !== "message" ||
      keys[1] !== "content" ||
      !["text", "thinking"].includes(String(keys[3]))
    ) {
      return;
    }
    this.length += text.length;
    if (this.length > 16 * 1024 * 1024 || Number(keys[2]) >= 4096) {
      this.unavailable = true;
      this.fields.clear();
      return;
    }
    const index = Number(keys[2]);
    this.fields.set(index, (this.fields.get(index) ?? "") + text);
  }
  private partText(part: Readonly<Record<string, unknown>>, index: number): string {
    if (part.type === "text" || part.type === "thinking") {
      return stripTerminalSequences(this.fields.get(index) ?? "");
    }
    return part.type === "image" ? `[Image: ${string(part.mimeType) ?? "image"}]` : "";
  }
  fingerprints(
    value: Readonly<Record<string, unknown>>,
    id: string,
  ): readonly (readonly [string, string])[] {
    const message = object(value.message);
    if (this.unavailable || value.type !== "message" || message.role !== "assistant") {
      return [];
    }
    const content = objects(message.content);
    const first = content.findIndex(
      (part, index) =>
        (part.type === "text" || part.type === "thinking") &&
        (this.fields.get(index)?.length ?? 0) > 0,
    );
    if (
      first < 0 ||
      !content.some(
        (part, index) => part.type === "text" && (this.fields.get(index)?.length ?? 0) > 0,
      )
    ) {
      return [];
    }
    const item = `${id}:${first}`;
    const parts = content
      .map((part, index) => this.partText(part, index))
      .filter((text) => text.length > 0);
    const texts = [
      parts.join("\n"),
      ...content.flatMap((part, index) =>
        part.type === "text" ? [stripTerminalSequences(this.fields.get(index) ?? "")] : [],
      ),
    ];
    return [
      ...new Set(
        texts.map((text) => stripAcceptanceReport(text).trim()).filter((text) => text.length > 0),
      ),
    ].map((text) => [exactTextDigest(text), item]);
  }
}
