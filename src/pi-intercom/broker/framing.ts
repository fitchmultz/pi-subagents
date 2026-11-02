import type { Socket } from "net";
import { errorMessage } from "../../shared/unknown.ts";

export const MAX_FRAME_SIZE_BYTES = 1024 * 1024;

export function intercomMessageSizeBytes(msg: unknown): number {
  return Buffer.byteLength(JSON.stringify(msg), "utf-8");
}

export function validateIntercomMessageSize(msg: unknown): Error | null {
  const size = intercomMessageSizeBytes(msg);
  return size > MAX_FRAME_SIZE_BYTES
    ? new Error(`Intercom message too large (${size} bytes; max ${MAX_FRAME_SIZE_BYTES})`)
    : null;
}

/**
 * Write a length-prefixed message to a socket.
 * Format: 4-byte big-endian length + JSON payload
 */
export function writeMessage(socket: Socket, msg: unknown): void {
  writeFrame(socket, JSON.stringify(msg));
}

/** Write serialized JSON; false means Node accepted it but the caller should wait for drain. */
export function writeFrame(socket: Socket, json: string, limit = MAX_FRAME_SIZE_BYTES): boolean {
  const size = Buffer.byteLength(json, "utf-8");
  if (size > limit) {
    throw new Error(`Intercom message too large (${size} bytes; max ${limit})`);
  }
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return socket.write(Buffer.concat([header, payload]));
}

/** Retain fragments until a header or payload is complete; copy each fragmented value once. */
class MessageBuffer {
  private chunks: Buffer[] = [];
  private index = 0;
  length = 0;

  append(data: Buffer): void {
    if (data.length > 0) {
      this.chunks.push(data);
      this.length += data.length;
    }
  }

  clear(): void {
    this.chunks = [];
    this.index = 0;
    this.length = 0;
  }

  read(size: number): Buffer {
    const first = this.chunks[this.index];
    if (size === 0) {
      return Buffer.alloc(0);
    }
    if (first === undefined) {
      throw new Error("Frame reader has no buffered chunk for a non-empty read.");
    }
    const result = first.length >= size ? first.subarray(0, size) : Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      const chunk = this.chunks[this.index];
      if (chunk === undefined) {
        throw new Error("Frame reader ran out of buffered chunks mid-read.");
      }
      const count = Math.min(chunk.length, size - written);
      if (first.length < size) {
        chunk.copy(result, written, 0, count);
      }
      written += count;
      this.length -= count;
      if (count === chunk.length) {
        this.index++;
      } else {
        this.chunks[this.index] = chunk.subarray(count);
      }
    }
    if (this.index === this.chunks.length) {
      this.clear();
    } else if (this.index * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.index);
      this.index = 0;
    }
    return result;
  }
}

/**
 * Create a message reader that handles partial reads.
 * Calls onMessage for each complete message received.
 * Protocol or handler errors are reported to onError so the caller can close the socket.
 */
export function createMessageReader(
  onMessage: (msg: unknown) => void,
  onError: (error: Readonly<Error>) => void,
  limit = MAX_FRAME_SIZE_BYTES,
): (data: Buffer) => void {
  const buffer = new MessageBuffer();
  let length: number | undefined;

  return (data: Buffer) => {
    buffer.append(data);

    while (buffer.length >= (length ?? 4)) {
      if (length === undefined) {
        length = buffer.read(4).readUInt32BE(0);
        if (length > limit) {
          onError(new Error(`Intercom frame too large (${length} bytes; max ${limit})`));
          buffer.clear();
          length = undefined;
          return;
        }
        continue;
      }

      const payload = buffer.read(length);
      length = undefined;

      let msg: unknown;
      try {
        msg = JSON.parse(payload.toString("utf-8"));
      } catch (error) {
        const message = errorMessage(error);
        onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error }));
        return;
      }

      try {
        onMessage(msg);
      } catch (error) {
        const message = errorMessage(error);
        onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error }));
        return;
      }
    }
  };
}
