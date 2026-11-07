import { attachmentSchema } from "./contracts.ts";
import { observeAlive, published } from "./process.ts";
import { read } from "./storage.ts";

/** A parent liveness verdict acts only while its check and attachment generation are current. */
export class ParentCheck {
  private current?: object | undefined;
  check(file: string, detached: () => void): Promise<void> {
    if (this.current !== undefined) {
      return Promise.resolve();
    }
    const attachment = published(file, read(file, attachmentSchema));
    if (attachment === undefined || !attachment.attached) {
      detached();
      return Promise.resolve();
    }
    const check = {};
    this.current = check;
    const settle = async () => {
      try {
        const [live] = await observeAlive([attachment]);
        if (
          this.current === check &&
          live !== true &&
          read(file, attachmentSchema)?.generation === attachment.generation
        ) {
          detached();
        }
      } finally {
        if (this.current === check) {
          this.current = undefined;
        }
      }
    };
    return settle();
  }
  cancel(): void {
    this.current = undefined;
  }
}
