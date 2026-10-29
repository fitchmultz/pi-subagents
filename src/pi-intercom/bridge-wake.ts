import { createHash } from "node:crypto";
import { log } from "./bridge-protocol.ts";
import { Mailbox, type PendingNotification } from "./bridge-mailbox.ts";
import type { Identity } from "./bridge-config.ts";
import { WakeState } from "./bridge-wake-state.ts";

interface Delivery {
  readonly identity: Identity;
  readonly mailbox: Mailbox;
  readonly expires: number;
  readonly controller: AbortController;
}
interface Candidate {
  readonly delivery: Delivery;
  readonly entry: PendingNotification;
}

function actionable(entry: PendingNotification): boolean {
  const message = entry.message;
  if (entry.acknowledged || message.passive === true || message.delivery === "passive") {
    return false;
  }
  return (
    message.expectsReply === true ||
    !/^(?:ACK|DUP-ACK|FYI|NOTE|RECEIPT|NOWAKE)(?=$|[\s:])/.test(message.content.text)
  );
}

function bucket(identity: Identity): string {
  return createHash("sha256")
    .update(identity.wake?.url ?? "")
    .digest("hex");
}

/** Mailbox commits and durable retry/quota deadlines drive wakes; there is no intake scan timer. */
export class WakeDeliveries {
  private readonly stateDir: string | undefined;
  private readonly state?: WakeState;
  private readonly allowed: (identity: Identity) => boolean;
  private readonly deliveries = new Map<string, Delivery>();
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private dirty = false;
  private storageBackoff = 15000;

  constructor(stateDir: string | undefined, allowed: (identity: Identity) => boolean) {
    this.stateDir = stateDir;
    this.allowed = allowed;
    // Initialize before any presence proof/mailbox is created, so genuinely fresh installs start now.
    this.state = stateDir === undefined ? undefined : new WakeState(stateDir);
  }

  session(identity: Identity, expires: number): void {
    if (
      !identity.wake ||
      this.stateDir === undefined ||
      this.deliveries.has(identity.fingerprint256)
    ) {
      return;
    }
    this.deliveries.set(identity.fingerprint256, {
      identity,
      expires,
      mailbox: new Mailbox(this.stateDir, identity.fingerprint256, true),
      controller: new AbortController(),
    });
    // Startup restores every certificate proof synchronously before the scheduled reconciliation.
    // An empty first fingerprint must not clear another retained fingerprint's durable cold batch.
    this.changed(false);
  }

  changed(reconcile = true): void {
    if (this.controller.signal.aborted) {
      return;
    }
    try {
      // ACK may be followed by fresh mail before the event timer runs. Clear completed batches now
      // so a new obligation does not inherit a completed batch's uncertainty/backoff.
      if (reconcile) {
        this.reconcile();
      }
    } catch {
      // The scheduled storage recovery fails closed; never let an event bypass durable admission.
    }
    if (this.running) {
      this.dirty = true;
    } else {
      this.schedule(Date.now());
    }
  }

  private reconcile(): void {
    for (const [key, candidate] of this.groups()) {
      if (candidate) {
        this.state?.deadline(key);
      } else {
        this.state?.retire(key);
      }
    }
  }

  private schedule(deadline: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.dirty = false;
        let next = Infinity;
        this.running = this.deliver()
          .then((due) => {
            next = due;
            this.storageBackoff = 15000;
            return;
          })
          .catch(() => {
            log("wake_delivery", { result: "storage_unavailable" });
            next = Date.now() + this.storageBackoff;
            this.storageBackoff = Math.min(this.storageBackoff * 2, 300000);
          })
          .finally(() => {
            this.running = undefined;
            if (!this.controller.signal.aborted && (this.dirty || Number.isFinite(next))) {
              this.schedule(this.dirty ? Date.now() : next);
            }
          });
      },
      Math.max(0, Math.min(deadline - Date.now(), 0x7fffffff)),
    );
  }

  private authorized(delivery: Delivery): boolean {
    return (
      !this.controller.signal.aborted &&
      this.allowed(delivery.identity) &&
      delivery.expires > Date.now()
    );
  }

  private pending(delivery: Delivery): PendingNotification | undefined {
    let after = 0;
    let page;
    do {
      // Decode only the retired prefix and the oldest actionable entry, not the whole backlog.
      page = delivery.mailbox.pendingNotifications(after, 1);
      for (const entry of page.messages) {
        if (actionable(entry)) {
          return entry;
        }
        // Retire only notification intent. Payload/reply obligations require actual ACK/reply.
        delivery.mailbox.notificationAccepted(entry.message.id);
      }
      after = Number(page.nextCursor);
    } while (page.hasMore);
    return undefined;
  }

  private groups(): Map<string, Candidate | undefined> {
    const groups = new Map<string, Candidate | undefined>();
    for (const delivery of this.deliveries.values()) {
      if (!this.authorized(delivery)) {
        continue;
      }
      const key = bucket(delivery.identity);
      const entry = this.pending(delivery);
      const previous = groups.get(key);
      if (
        !groups.has(key) ||
        (entry && (!previous || entry.receivedAt < previous.entry.receivedAt))
      ) {
        groups.set(key, entry ? { delivery, entry } : undefined);
      }
    }
    return groups;
  }

  private async deliver(): Promise<number> {
    const state = this.state;
    let next = Infinity;
    if (!state) {
      return next;
    }
    // ACK can remove the final candidate while its failed completion write still needs recovery.
    state.retrySettlement();
    for (const [key, candidate] of this.groups()) {
      if (!candidate) {
        state.retire(key);
        continue;
      }
      const due = state.deadline(key);
      if (due > Date.now()) {
        next = Math.min(next, due);
        continue;
      }
      const deferred = state.reserve(key);
      if (deferred !== undefined) {
        next = Math.min(next, deferred);
        continue;
      }
      // ponytail: two cold Macs can each admit one wake. Literal cross-Mac single admission
      // requires a neutral quota authority governing every writer, not a URL hash or HTTP 2xx.
      try {
        // oxlint-disable-next-line no-await-in-loop
        await this.post(candidate);
      } finally {
        // Expiry starts after response/error/abort, never before COMMIT or connect/TLS.
        state.settle();
      }
      // Re-read ACKs and all groups after transport I/O; a snapshot must not wake already consumed mail.
      return Date.now();
    }
    return next;
  }

  private async post({ delivery, entry }: Candidate): Promise<void> {
    const policy = delivery.identity.wake;
    if (!policy || !this.authorized(delivery)) {
      return;
    }
    const fields = { name: delivery.identity.name, messageId: entry.message.id };
    try {
      const response = await fetch(policy.url, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${policy.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: entry.from.name ?? entry.from.id,
          from_id: entry.from.id,
          to: delivery.identity.name,
          message_id: entry.message.id,
          ask_id: entry.message.expectsReply === true ? entry.message.id : null,
          text: entry.message.content.text,
        }),
        signal: AbortSignal.any([
          this.controller.signal,
          delivery.controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      await response.body?.cancel();
      // Acceptance does not consume mail or reset uncertainty: only real inbox ACK retires intent.
      log("wake_delivery", {
        ...fields,
        result: response.ok ? "accepted" : "http_rejected",
        status: response.status,
      });
    } catch {
      if (!this.controller.signal.aborted) {
        log("wake_delivery", { ...fields, result: "transport_unconfirmed" });
      }
    }
  }

  drop(fp: string): void {
    const delivery = this.deliveries.get(fp);
    this.deliveries.delete(fp);
    delivery?.controller.abort();
    delivery?.mailbox.close();
    // Membership removal alone is not an ACK. Reload restores proof-backed replacements first.
    this.changed(false);
  }

  reload(): void {
    for (const [fp, delivery] of this.deliveries) {
      if (!this.allowed(delivery.identity)) {
        this.drop(fp);
      }
    }
    this.changed(false);
  }

  async stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    await this.running;
    for (const delivery of this.deliveries.values()) {
      delivery.mailbox.close();
    }
    this.deliveries.clear();
    this.state?.close();
  }
}
