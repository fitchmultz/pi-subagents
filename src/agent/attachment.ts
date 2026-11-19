import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attachmentSchema, type Attachment, type ProcessIdentity } from "./contracts.ts";
import type { ManagedHost } from "./host.ts";
import { alive, published } from "./process.ts";
import { read, write } from "./storage.ts";
import { OwnershipLock } from "./ownership-lock.ts";

export interface AttachmentBinding {
  readonly context: ExtensionContext;
  readonly owner: string;
  readonly base: string;
  readonly host: ManagedHost | undefined;
}
export type AttachmentState =
  | { readonly kind: "detached" }
  | { readonly kind: "waiting"; readonly binding: AttachmentBinding }
  | {
      readonly kind: "attaching" | "attached" | "failed";
      readonly binding: AttachmentBinding;
      readonly generation: string;
    };

export function releasesAttachment(state: AttachmentState, attachment: Attachment): boolean {
  switch (state.kind) {
    case "detached":
      return false;
    case "waiting":
      // An unready replacement can release the launcher's existing generation on quit.
      return attachment.attached && attachment.pid === state.binding.host?.owner.pid;
    case "attaching":
    case "attached":
    case "failed":
      return attachment.generation === state.generation;
  }
}

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
