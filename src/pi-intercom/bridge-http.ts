import type { IncomingMessage, ServerResponse } from "node:http";
import { BODY_LIMIT, Fault } from "./bridge-protocol.ts";
import { errorMessage, type UnknownRecord } from "../shared/unknown.ts";

function validateHeaders(req: IncomingMessage): void {
  const type = req.headers["content-type"];
  if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
    throw new Fault(415, "content_type", "Use application/json.");
  }
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
    throw new Fault(413, "body_too_large", "JSON body exceeds 64 KiB.");
  }
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Readonly<Error>) => {
      cleanup();
      req.pause();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      req.pause();
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    };
    const onError = () => fail(new Fault(400, "invalid_body", "Could not read JSON body."));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new Fault(413, "body_too_large", "JSON body exceeds 64 KiB."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(
      () => fail(new Fault(408, "body_timeout", "JSON body deadline exceeded.")),
      10000,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    if (signal.aborted) {
      onAbort();
    }
  });
}

export async function body(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  validateHeaders(req);
  const data = await readBody(req, signal);
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    return value;
  } catch {
    throw new Fault(400, "invalid_json", "Invalid UTF-8 JSON body.");
  }
}

export function reply(
  res: ServerResponse,
  requestId: string,
  status: number,
  data: UnknownRecord,
): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  const payload = JSON.stringify({ ...data, requestId });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
  });
  res.end(payload);
}
