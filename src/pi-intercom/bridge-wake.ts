import { log } from "./bridge-protocol.ts";
import { Mailbox, type PendingNotification } from "./bridge-mailbox.ts";
import type { Identity, WakePolicy } from "./bridge-config.ts";

const POLL_MS = 15000;
const FALLBACK_AFTER_MS = 120000;
const MAX_BACKOFF_MS = 300000;

export class WakeDelivery {
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private backoff = POLL_MS;
  private readonly name: string;
  private readonly mailbox: Pick<Mailbox, "pendingNotifications" | "notificationAccepted">;
  private readonly policy: WakePolicy;
  private readonly authorized: () => boolean;

  constructor(
    name: string,
    mailbox: Pick<Mailbox, "pendingNotifications" | "notificationAccepted">,
    policy: WakePolicy,
    authorized: () => boolean,
  ) {
    this.name = name;
    this.mailbox = mailbox;
    this.policy = policy;
    this.authorized = authorized;
  }

  start(): void {
    if (!this.running && !this.controller.signal.aborted) {
      this.schedule(0);
    }
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.running = this.deliver()
        .catch(() => {
          log("wake_delivery", { name: this.name, result: "storage_unavailable" });
          this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        })
        .finally(() => {
          this.running = undefined;
          if (!this.controller.signal.aborted) {
            this.schedule(this.backoff);
          }
        });
    }, delay);
  }

  private async deliver(): Promise<void> {
    if (!this.authorized()) {
      return;
    }
    const entries = this.mailbox.pendingNotifications().messages;
    for (const entry of entries) {
      if (entry.acknowledged) {
        // The box's durable worker owns primary wake/replay after acknowledgement.
        this.mailbox.notificationAccepted(entry.message.id);
      }
    }
    const next = entries.find(
      (entry) => !entry.acknowledged && Date.now() - entry.receivedAt >= FALLBACK_AFTER_MS,
    );
    if (next) {
      // One fallback wakes the box to drain the remaining mailbox; never flood a reset VM.
      await this.post(next);
      return;
    }
    this.backoff = POLL_MS;
  }

  private async post(entry: PendingNotification): Promise<void> {
    if (!this.authorized()) {
      return;
    }
    const fields = { name: this.name, messageId: entry.message.id };
    try {
      const response = await fetch(this.policy.url, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.policy.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: entry.from.name ?? entry.from.id,
          from_id: entry.from.id,
          to: this.name,
          message_id: entry.message.id,
          ask_id: entry.message.expectsReply === true ? entry.message.id : null,
          text: entry.message.content.text,
        }),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]),
      });
      await response.body?.cancel();
      if (response.ok && !this.controller.signal.aborted && this.authorized()) {
        this.mailbox.notificationAccepted(entry.message.id);
        this.backoff = POLL_MS;
        log("wake_delivery", { ...fields, result: "accepted" });
      } else {
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        log("wake_delivery", { ...fields, result: "http_rejected", status: response.status });
      }
    } catch {
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      if (!this.controller.signal.aborted) {
        log("wake_delivery", { ...fields, result: "transport_unconfirmed" });
      }
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    await this.running;
  }
}

export class WakeDeliveries {
  private readonly stateDir: string | undefined;
  private readonly allowed: (identity: Identity) => boolean;
  private readonly deliveries = new Map<
    string,
    { readonly identity: Identity; readonly mailbox: Mailbox; readonly worker: WakeDelivery }
  >();
  private readonly cleanup = new Set<Promise<unknown>>();

  constructor(stateDir: string | undefined, allowed: (identity: Identity) => boolean) {
    this.stateDir = stateDir;
    this.allowed = allowed;
  }

  session(identity: Identity, expires: number): void {
    if (
      !identity.wake ||
      this.stateDir === undefined ||
      this.deliveries.has(identity.fingerprint256)
    ) {
      return;
    }
    const mailbox = new Mailbox(this.stateDir, identity.fingerprint256, true);
    const worker = new WakeDelivery(
      identity.name,
      mailbox,
      identity.wake,
      () => this.allowed(identity) && expires > Date.now(),
    );
    this.deliveries.set(identity.fingerprint256, { identity, mailbox, worker });
    worker.start();
  }

  drop(fp: string): void {
    const delivery = this.deliveries.get(fp);
    if (!delivery) {
      return;
    }
    this.deliveries.delete(fp);
    const cleanup = delivery.worker
      .stop()
      .then(() => delivery.mailbox.close())
      .catch(() => {
        log("wake_delivery", { name: delivery.identity.name, result: "cleanup_failed" });
      })
      .finally(() => {
        this.cleanup.delete(cleanup);
      });
    this.cleanup.add(cleanup);
  }

  reload(): void {
    for (const [fp, delivery] of this.deliveries) {
      if (!this.allowed(delivery.identity)) {
        this.drop(fp);
      }
    }
  }

  async stop(): Promise<void> {
    for (const fp of this.deliveries.keys()) {
      this.drop(fp);
    }
    await Promise.all(this.cleanup);
  }
}
