import { join } from "node:path";
import { isRecord } from "../shared/unknown.ts";
import type { Identity } from "./bridge-config.ts";
import { readBridgeFile, writeBridgeJson } from "./bridge-files.ts";
import { log } from "./bridge-protocol.ts";

interface Registration {
  readonly fingerprint: string;
  readonly name: string;
  readonly cwd: string;
  readonly expires: number;
}

interface PresenceOwner {
  readonly stateDir: string;
  readonly clients: () => ReadonlyMap<string, Identity>;
  readonly connect: (identity: Identity, expires: number) => Promise<void>;
  readonly restored: (identity: Identity, expires: number) => void;
}

export class PersistentPresence {
  private readonly registrations = new Map<string, Registration>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly owner: PresenceOwner;

  constructor(owner: PresenceOwner) {
    this.owner = owner;
    this.restoreAll();
  }

  restoreAll(): void {
    for (const identity of this.owner.clients().values()) {
      this.restore(identity);
    }
  }

  private path(fingerprint: string): string {
    return join(this.owner.stateDir, `presence-${fingerprint}.json`);
  }

  private restore(identity: Identity): void {
    try {
      const value: unknown = JSON.parse(
        readBridgeFile(this.path(identity.fingerprint256), true, 8192).toString("utf8"),
      );
      if (
        isRecord(value) &&
        value.fingerprint === identity.fingerprint256 &&
        value.name === identity.name &&
        value.cwd === identity.cwd &&
        typeof value.expires === "number" &&
        Number.isFinite(value.expires) &&
        value.expires > Date.now()
      ) {
        this.registrations.set(identity.fingerprint256, {
          fingerprint: identity.fingerprint256,
          name: identity.name,
          cwd: identity.cwd,
          expires: value.expires,
        });
        this.owner.restored(identity, value.expires);
      }
    } catch {
      // An absent/invalid saved registration never grants a certificate identity.
    }
  }

  authenticated(identity: Identity, expires: number): void {
    const previous = this.registrations.get(identity.fingerprint256);
    if (
      previous?.expires === expires &&
      previous.name === identity.name &&
      previous.cwd === identity.cwd
    ) {
      return;
    }
    const registration = {
      fingerprint: identity.fingerprint256,
      name: identity.name,
      cwd: identity.cwd,
      expires,
    };
    writeBridgeJson(this.path(identity.fingerprint256), registration);
    this.registrations.set(identity.fingerprint256, registration);
    this.start();
  }

  start(): void {
    if (!this.stopped && !this.running) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.running = this.maintain().finally(() => {
          this.running = undefined;
          if (!this.stopped) {
            this.timer = setTimeout(() => this.start(), 15000);
          }
        });
      }, 0);
    }
  }

  private async maintain(): Promise<void> {
    for (const registration of this.registrations.values()) {
      if (this.stopped) {
        return;
      }
      const identity = this.owner.clients().get(registration.fingerprint);
      if (
        !identity ||
        identity.name !== registration.name ||
        identity.cwd !== registration.cwd ||
        registration.expires <= Date.now()
      ) {
        this.registrations.delete(registration.fingerprint);
        continue;
      }
      try {
        // Each identity has one connection attempt; preserve the native broker's spawn safeguards.
        // oxlint-disable-next-line no-await-in-loop
        await this.owner.connect(identity, registration.expires);
      } catch {
        log("presence_retry", { name: identity.name, result: "broker_unavailable" });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
