import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPiAgentDir } from "../pi-intercom/agent-dir.ts";

/** One active failure per owner. Recovery is established by the owner, not by the reporter. */
export class BackgroundReporter {
  private readonly episodes = new Map<string, string>();
  private readonly context: () => ExtensionContext | null | undefined;
  private shuttingDown = false;
  private headless = false;
  constructor(context: () => ExtensionContext | null | undefined) {
    this.context = context;
  }
  start(): void {
    this.shuttingDown = false;
  }
  shutdown(): void {
    try {
      this.headless = this.context()?.hasUI === false;
    } catch {
      this.headless = false;
    }
    this.shuttingDown = true;
  }
  recover(owner: string): void {
    this.episodes.delete(owner);
  }
  private published(owner: string | undefined, message: string): void {
    if (owner !== undefined) {
      this.episodes.set(owner, message);
    }
  }
  private repeated(owner: string | undefined, message: string): boolean {
    return owner !== undefined && this.episodes.get(owner) === message;
  }
  report(
    owner: string | undefined,
    message: string,
    severity: "warning" | "error" = "error",
  ): void {
    if (this.repeated(owner, message)) {
      return;
    }
    if (this.shuttingDown && this.headless) {
      console.error(message);
      this.published(owner, message);
      return;
    }
    try {
      const ctx = this.context();
      if (!this.shuttingDown && ctx) {
        if (ctx.hasUI) {
          ctx.ui.notify(message, severity);
        } else {
          console.error(message);
        }
        this.published(owner, message);
        return;
      }
    } catch {
      // A context may be invalidated between its owner's check and notification.
    }
    // Pi may have already stopped its renderer during session_shutdown. Never write to the terminal.
    try {
      const dir = path.join(getPiAgentDir(), "intercom");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        path.join(dir, "background-errors.log"),
        `${new Date().toISOString()} ${message}\n`,
        { mode: 0o600 },
      );
      this.published(owner, message);
    } catch {
      // No terminal write is safe here; the diagnostic store itself may be unavailable.
    }
  }
}
