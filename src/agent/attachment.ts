import * as path from "node:path";
import { attachmentSchema, type ProcessIdentity } from "./contracts.ts";
import { alive, published } from "./process.ts";
import { read, write } from "./storage.ts";
import { OwnershipLock } from "./ownership-lock.ts";

/** Refuse a foreign live main before publishing this attachment's generation. */
export function publishAttachment(
  base: string,
  identity: Omit<ProcessIdentity, "token">,
  generation: string,
): void {
  const lock = new OwnershipLock(base);
  try {
    const file = path.join(base, "attachment.json");
    const previous = published(file, read(file, attachmentSchema));
    if (
      previous?.attached === true &&
      (previous.pid !== identity.pid || previous.identity !== identity.identity) &&
      alive(previous)
    ) {
      throw new Error("Another live main is attached to this session; this main did not attach.");
    }
    write(file, { ...identity, generation, attached: true });
  } finally {
    lock.close();
  }
}
