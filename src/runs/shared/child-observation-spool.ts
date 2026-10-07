import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { ChildObservation } from "./child-attempt-types.ts";
import { errorMessage as errorText } from "../../shared/unknown.ts";
import { nonempty } from "./child-presence.ts";

export interface AuditResult {
  readonly auditPath?: string;
  readonly auditSaveError?: string;
  readonly auditRecords?: readonly {
    readonly kind: string;
    readonly messageNumber?: number;
    readonly offset: number;
    readonly length: number;
  }[];
}

/** Owns bounded streaming spools and transfers retained evidence to the durable audit. */
export class ChildObservationSpool {
  readonly directory: string;
  readonly wirePath: string;
  private wire = -1;
  private text = -1;
  private stderr = -1;
  private textOffset = 0;
  private readonly auditPath?: string;

  constructor(auditPath?: string) {
    this.auditPath = auditPath;
    const parent = nonempty(auditPath) ? path.dirname(auditPath) : tmpdir();
    fs.mkdirSync(parent, { recursive: true });
    this.directory = fs.mkdtempSync(path.join(parent, ".pi-subagents-wire-"));
    this.wirePath = path.join(this.directory, "stdout");
    try {
      this.wire = fs.openSync(this.wirePath, "wx+");
      this.text = fs.openSync(path.join(this.directory, "text"), "wx+");
      this.stderr = fs.openSync(path.join(this.directory, "stderr"), "wx+");
    } catch (error) {
      this.close();
      fs.rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
  }

  writeWire(bytes: Buffer): void {
    fs.writeFileSync(this.wire, bytes);
  }
  writeStderr(text: string): void {
    fs.writeFileSync(this.stderr, text);
  }
  resetText(): void {
    this.textOffset = 0;
    fs.ftruncateSync(this.text, 0);
  }
  appendText(text: string): void {
    const bytes = Buffer.from(text);
    for (let offset = 0; offset < bytes.length;) {
      const count = fs.writeSync(
        this.text,
        bytes,
        offset,
        bytes.length - offset,
        this.textOffset + offset,
      );
      if (count === 0) {
        throw new Error("Cannot write child output spool");
      }
      offset += count;
    }
    this.textOffset += bytes.length;
  }
  replayText(consume: (text: string) => void): void {
    this.decode(this.text, 0, this.textOffset, consume);
  }
  replayWire(start: number, end: number, consume: (text: string) => void): void {
    this.decode(this.wire, start, end, consume);
  }

  private copy(fd: number, start: number, end: number, consume: (bytes: Buffer) => void): void {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let position = start; position < end;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
      if (count === 0) {
        throw new Error("Missing child audit bytes");
      }
      consume(buffer.subarray(0, count));
      position += count;
    }
  }
  private decode(fd: number, start: number, end: number, consume: (text: string) => void): void {
    const decoder = new StringDecoder("utf8");
    this.copy(fd, start, end, (bytes) => consume(decoder.write(bytes)));
    const tail = decoder.end();
    if (tail.length > 0) {
      consume(tail);
    }
  }
  private close(): void {
    for (const fd of [this.wire, this.text, this.stderr]) {
      if (fd >= 0) {
        fs.closeSync(fd);
      }
    }
    this.wire = -1;
    this.text = -1;
    this.stderr = -1;
  }

  retain(observations: readonly ChildObservation[], receiverFailed: boolean): AuditResult {
    const retained = receiverFailed
      ? [
          {
            start: 0,
            end: fs.fstatSync(this.wire).size,
            kind: "receiver_failure",
            number: undefined,
          },
        ]
      : observations.filter((item) => item.nativeEntryId === undefined);
    const auditPath = this.auditPath ?? path.join(this.directory, "observations.log");
    const stderrLength = fs.fstatSync(this.stderr).size;
    let retainedWire = false;
    let result: AuditResult = {};
    try {
      if (retained.length > 0 || stderrLength > 0) {
        result = { auditPath, auditRecords: this.appendAudit(auditPath, retained, stderrLength) };
      }
    } catch (error) {
      retainedWire = true;
      result = { auditSaveError: errorText(error), auditPath: this.directory };
    } finally {
      this.close();
      if (!retainedWire) {
        this.removeWire(result.auditPath);
      }
    }
    return result;
  }

  private appendAudit(
    auditPath: string,
    retained: readonly ChildObservation[],
    stderrLength: number,
  ): NonNullable<AuditResult["auditRecords"]> {
    const audit = fs.openSync(auditPath, "a", 0o600);
    const records: Array<{ kind: string; messageNumber?: number; offset: number; length: number }> =
      [];
    try {
      let offset = fs.fstatSync(audit).size;
      for (const item of retained) {
        this.copy(this.wire, item.start, item.end, (bytes) => {
          fs.writeFileSync(audit, bytes);
        });
        records.push({
          kind: item.kind,
          messageNumber: item.number,
          offset,
          length: item.end - item.start,
        });
        offset += item.end - item.start;
      }
      if (stderrLength > 0) {
        this.copy(this.stderr, 0, stderrLength, (bytes) => {
          fs.writeFileSync(audit, bytes);
        });
        records.push({ kind: "stderr", offset, length: stderrLength });
      }
      return records;
    } finally {
      fs.closeSync(audit);
    }
  }
  private removeWire(auditPath: string | undefined): void {
    if (auditPath?.startsWith(`${this.directory}${path.sep}`) === true) {
      for (const file of [
        this.wirePath,
        path.join(this.directory, "text"),
        path.join(this.directory, "stderr"),
      ]) {
        fs.rmSync(file);
      }
    } else {
      fs.rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
