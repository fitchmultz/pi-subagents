import * as fs from "node:fs";
import * as path from "node:path";
import {
  readNestedControlRequests,
  writeNestedControlResult,
  type NestedControlRequestRecord,
  type NestedRoute,
} from "../runs/shared/nested-events.ts";
import { errorMessage, hasErrorCode } from "../shared/unknown.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";

type Request = ReadonlyInput<NestedControlRequestRecord & { filePath: string }>;
type Result = ReadonlyInput<Parameters<typeof writeNestedControlResult>[1]>;
interface InboxOptions {
  readonly route: ReadonlyInput<NestedRoute>;
  readonly childIndex?: number;
  readonly restoring: () => boolean;
  readonly owns: (runId: string) => boolean;
  readonly execute: (
    request: Request,
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
}

/** Owns claim-before-execute and durable-result-before-delete ordering. */
export class NestedControlInbox {
  private readonly seen = new Set<string>();
  private readonly seenFiles = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly pendingResults = new Map<string, Result>();
  private readonly timer: NodeJS.Timeout;

  private readonly options: InboxOptions;

  constructor(options: InboxOptions) {
    this.options = options;
    this.timer = setInterval(() => this.poll(), 200);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async stopAndJoin(): Promise<void> {
    this.stop();
    await Promise.all(this.inFlight.values());
  }

  private eligible(request: Request): boolean {
    if (this.seen.has(request.requestId) || this.inFlight.has(request.requestId)) {
      return false;
    }
    if (
      request.targetChildIndex !== undefined &&
      request.targetChildIndex !== this.options.childIndex
    ) {
      return false;
    }
    return (
      this.options.owns(request.targetRunId) ||
      (request.targetChildIndex === undefined && Date.now() - request.ts >= 400)
    );
  }

  private poll(): void {
    if (this.options.restoring()) {
      return;
    }
    try {
      for (const request of readNestedControlRequests(this.options.route, this.seenFiles)) {
        if (this.eligible(request)) {
          this.receive(request);
        }
      }
    } catch (error) {
      console.error(
        `Failed to poll nested control inbox '${this.options.route.controlInbox}' for root '${this.options.route.rootRunId}':`,
        error,
      );
    }
  }

  private receive(request: Request): void {
    // Reserve synchronously: filesystem-only controls can finish before the first await.
    const operation = Promise.resolve().then(() => this.process(request));
    const owned = operation
      .catch((error: unknown) => {
        console.error(`Failed to handle nested control request '${request.requestId}':`, error);
      })
      .finally(() => {
        this.inFlight.delete(request.requestId);
      });
    this.inFlight.set(request.requestId, owned);
  }

  private failure(request: Request, message: string): Result {
    return {
      ts: Date.now(),
      requestId: request.requestId,
      targetRunId: request.targetRunId,
      ok: false,
      message,
    };
  }

  private claim(request: Request): Result | undefined {
    if (this.pendingResults.size >= 100) {
      return this.failure(
        request,
        "Nested control result queue is full; retry after pending results are delivered.",
      );
    }
    try {
      const fd = fs.openSync(`${request.filePath}.claimed`, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${request.requestId}\n`, "utf-8");
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      return this.failure(
        request,
        hasErrorCode(error, "EEXIST")
          ? "Nested control request was already claimed; refusing to execute it again because the original outcome is unavailable."
          : `Failed to claim nested control request safely: ${errorMessage(error)}`,
      );
    }
    return undefined;
  }

  private async execute(request: Request): Promise<Result> {
    try {
      const outcome = await this.options.execute(request);
      return {
        ts: Date.now(),
        requestId: request.requestId,
        targetRunId: request.targetRunId,
        ...outcome,
      };
    } catch (error) {
      return this.failure(request, errorMessage(error));
    }
  }

  private async process(request: Request): Promise<void> {
    const result =
      this.pendingResults.get(request.requestId) ??
      this.claim(request) ??
      (await this.execute(request));
    try {
      writeNestedControlResult(this.options.route, result);
    } catch (error) {
      if (this.pendingResults.size < 100 || this.pendingResults.has(request.requestId)) {
        this.pendingResults.set(request.requestId, result);
      }
      console.error(
        `Failed to write nested control result for request '${request.requestId}' targeting '${request.targetRunId}' via inbox '${this.options.route.controlInbox}'; keeping request for retry:`,
        error,
      );
      return;
    }
    this.pendingResults.delete(request.requestId);
    this.remember(request);
    this.remove(request);
  }

  private remember(request: Request): void {
    for (const [set, value] of [
      [this.seen, request.requestId],
      [this.seenFiles, path.basename(request.filePath)],
    ] as const) {
      set.add(value);
      if (set.size > 1000) {
        const oldest = set.values().next().value;
        if (oldest !== undefined) {
          set.delete(oldest);
        }
      }
    }
  }

  private remove(request: Request): void {
    try {
      fs.unlinkSync(request.filePath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        return;
      }
    }
    try {
      fs.unlinkSync(`${request.filePath}.claimed`);
    } catch {
      // A leftover claim prevents replay; the durable receipt is already published.
    }
  }
}
