import { JournalFrames, scanJournal } from "../../shared/journal-reader.ts";
import type { ReadonlyInput, ObservedMessage } from "../../shared/types.ts";
import type { ChildObservationSpool } from "./child-observation-spool.ts";
import type { ChildObservation } from "./child-attempt-types.ts";
import { ExitCodeObservation, createMessageReferenceIndex } from "./child-observations.ts";
import {
  claudeProjection,
  liveKeyLimit,
  liveProjection,
  projectedMessage,
  projectedPart,
} from "./child-stream-projection.ts";
import { isObject } from "./child-json.ts";
import type { NativeUsageMetadata } from "./native-usage.ts";

type SpoolAccess = ReadonlyInput<
  Pick<
    ChildObservationSpool,
    "wirePath" | "writeWire" | "resetText" | "appendText" | "replayText" | "replayWire"
  >
>;
interface StreamOptions {
  readonly claude: boolean;
  readonly sessionFile?: string;
  readonly consume: (
    value: Readonly<Record<string, unknown>>,
    textWritten: boolean,
  ) => { readonly messageCount: number; readonly message?: ObservedMessage };
  readonly output?: (text: string) => void;
  readonly rawLine?: (stream: "stdout" | "stderr", line: string) => void;
}

function needsAttributionReplay(
  keys: readonly (string | number)[],
  root?: Readonly<Record<string, unknown>>,
): boolean {
  return (
    (keys.at(-1) === "text" && projectedMessage(root)?.role === undefined) ||
    (keys.includes("arguments") && projectedPart(root, keys[2])?.name === undefined)
  );
}
function isCompletedMessageText(
  keys: readonly (string | number)[],
  root?: Readonly<Record<string, unknown>>,
): boolean {
  return (
    root?.type === "message_end" &&
    keys[0] === "message" &&
    keys[1] === "content" &&
    (keys.at(-1) === "text" || keys.length === 2)
  );
}

/** Owns record framing, member-order replay, text decoding and native observation references. */
export class ChildStreamObserver {
  private readonly spool: SpoolAccess;
  private readonly options: StreamOptions;
  private readonly frames: JournalFrames;
  private readonly observations: ChildObservation[] = [];
  private readonly references = createMessageReferenceIndex<ChildObservation>();
  private textWritten = false;
  private exitObservation = new ExitCodeObservation();
  private firstTextPath?: string;
  private outputTextPath?: string;
  private pendingSurrogate = "";
  private reproject = false;
  private replayOutput = false;
  rawOutput = "";

  constructor(spool: SpoolAccess, options: StreamOptions) {
    this.spool = spool;
    this.options = options;
    this.frames = new JournalFrames(
      (keys, root) => this.select(keys, root),
      (record) => this.record(record.value, record.start, record.end),
      {
        policy: "inspect",
        start: 0,
        malformed: (start, end) => this.diagnostic(start, end),
        stringChunk: (keys, text, root) => this.consumeText(keys, text, root),
        keys: liveKeyLimit,
      },
    );
  }
  write(bytes: Buffer): void {
    this.spool.writeWire(bytes);
    this.frames.write(bytes);
  }
  saveUnparsed(bytes: Buffer): void {
    this.spool.writeWire(bytes);
  }
  finish(): void {
    this.frames.finish();
  }
  reference(entry: NativeUsageMetadata): ChildObservation | undefined {
    return this.references.reference(entry);
  }
  observed(): ChildObservation[] {
    const observations: ChildObservation[] = [];
    for (const item of this.observations) {
      observations.push({ ...item, nativeEntryId: this.references.entryId(item) });
    }
    return observations;
  }
  published(publishedIds: Readonly<ReadonlySet<string>>): ChildObservation[] {
    const observations: ChildObservation[] = [];
    for (const item of this.observed()) {
      observations.push({
        ...item,
        nativeEntryId:
          item.nativeEntryId !== undefined && publishedIds.has(item.nativeEntryId)
            ? item.nativeEntryId
            : undefined,
      });
    }
    return observations;
  }

  private select(
    keys: readonly (string | number)[],
    root?: Readonly<Record<string, unknown>>,
  ): boolean | number {
    if (this.options.claude) {
      return claudeProjection(keys);
    }
    if (keys[0] !== "message" || keys[1] !== "content") {
      return liveProjection(keys, root);
    }
    if (root?.type === undefined) {
      this.replayOutput = true;
      this.reproject = true;
    }
    if (needsAttributionReplay(keys, root)) {
      this.reproject = true;
    }
    return liveProjection(keys, root);
  }

  private reset(): void {
    this.textWritten = false;
    this.exitObservation = new ExitCodeObservation();
    this.firstTextPath = undefined;
    this.pendingSurrogate = "";
    this.outputTextPath = undefined;
    this.reproject = false;
    this.replayOutput = false;
    this.spool.resetText();
  }

  private consumeText(
    keys: readonly (string | number)[],
    text: string,
    root?: Readonly<Record<string, unknown>>,
  ): void {
    if (!isCompletedMessageText(keys, root)) {
      return;
    }
    const key = keys.join(".");
    this.selectOutputText(key, text);
    // JSON escape tokens may split a surrogate pair; join it before UTF-8 encoding.
    const joined = this.pendingSurrogate + text;
    const last = joined.at(-1) ?? "";
    this.pendingSurrogate = /[\uD800-\uDBFF]/.test(last) ? last : "";
    const output = this.pendingSurrogate.length > 0 ? joined.slice(0, -1) : joined;
    if (output.length > 0) {
      this.textWritten = true;
      this.spool.appendText(output);
    }
    if (keys.length === 4) {
      this.firstTextPath ??= key;
      if (this.firstTextPath === key) {
        this.exitObservation.write(text);
      }
    }
  }

  private selectOutputText(key: string, text: string): void {
    if (this.outputTextPath === key) {
      return;
    }
    this.flushSurrogate();
    if (this.textWritten && text.length > 0) {
      this.spool.appendText("\n");
    }
    this.outputTextPath = key;
  }
  private flushSurrogate(): void {
    if (this.pendingSurrogate.length > 0) {
      this.textWritten = true;
      this.spool.appendText(this.pendingSurrogate);
    }
    this.pendingSurrogate = "";
  }

  private replay(
    projected: Readonly<Record<string, unknown>>,
    start: number,
    end: number,
  ): Readonly<Record<string, unknown>> {
    let value = projected;
    for (let pass = 0; pass < 2; pass++) {
      const known = value;
      scanJournal(
        this.spool.wirePath,
        (keys, root) =>
          liveProjection(keys, {
            ...root,
            type: known.type,
            message: {
              ...projectedMessage(root),
              role: projectedMessage(known)?.role,
              content: projectedMessage(known)?.content ?? projectedMessage(root)?.content,
            },
          }),
        (record) => {
          value = record.value;
        },
        {
          start,
          end,
          policy: "strict",
          keys: liveKeyLimit,
          ...(pass === 0 && this.replayOutput
            ? {
                stringChunk: (keys, text, root) =>
                  this.consumeText(keys, text, { ...root, type: known.type }),
              }
            : {}),
        },
      );
    }
    return value;
  }

  private record(projected: unknown, start: number, end: number): void {
    if (!isObject(projected)) {
      this.reset();
      return;
    }
    let value =
      this.reproject && projected.type === "message_end"
        ? this.replay(projected, start, end)
        : projected;
    this.reproject = false;
    this.replayOutput = false;
    this.flushSurrogate();
    this.outputTextPath = undefined;
    this.spool.replayText((text) => {
      this.options.output?.(text);
    });
    value = this.finalMessageMetadata(value);
    const observed = this.options.consume(value, this.textWritten);
    this.retainObservation(value, { start, end }, observed);
    this.reset();
  }
  private finalMessageMetadata(
    value: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    if (
      this.exitObservation.value !== undefined &&
      value.type === "message_end" &&
      projectedMessage(value)?.role === "toolResult"
    ) {
      return {
        ...value,
        message: { ...projectedMessage(value), observedExitCode: this.exitObservation.value },
      };
    }
    return value;
  }
  private retainObservation(
    value: Readonly<Record<string, unknown>>,
    range: { readonly start: number; readonly end: number },
    observed: { readonly messageCount: number; readonly message?: ObservedMessage },
  ): void {
    if (
      value.type === "message_end" ||
      value.type === "tool_execution_end" ||
      (this.options.claude && (value.type !== "result" || this.options.sessionFile === undefined))
    ) {
      const item: ChildObservation = {
        ...range,
        kind: typeof value.type === "string" ? value.type : "diagnostic",
        ...(value.type === "message_end"
          ? { number: observed.messageCount, message: observed.message }
          : {}),
      };
      this.observations.push(item);
      this.references.add(item);
    }
  }

  private diagnostic(start: number, end: number): void {
    this.observations.push({ start, end, kind: "diagnostic" });
    this.spool.replayWire(start, end, (text) => {
      this.rawOutput = (this.rawOutput + text).slice(-16384);
      this.options.output?.(text);
      this.options.rawLine?.("stdout", text);
    });
    this.reset();
  }
}
