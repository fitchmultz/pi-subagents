import type { TUI } from "@earendil-works/pi-tui";
import type { Watch } from "./observe-client.ts";
import { ObserverTranscript, type EntryAnchor } from "./observe-transcript.ts";
import { ScrollView } from "./observe-layout.ts";

export class Reading {
  readonly watch: Watch;
  readonly transcript: ObserverTranscript;
  readonly scroll: InstanceType<typeof ScrollView>;
  following = true;
  pending = false;
  width = 0;
  destination?: EntryAnchor;
  private readonly changed: (kind: "history" | "content") => void;
  constructor(
    watch: Watch,
    options: {
      tui: TUI;
      hideThinking: boolean;
      changed: (kind: "history" | "content") => void;
      loaded: () => void;
    },
  ) {
    this.watch = watch;
    this.changed = options.changed;
    const { sessionFile: file, sessionId, cwd } = watch.launch;
    this.transcript = new ObserverTranscript({
      ...options,
      file,
      sessionId,
      cwd,
      changed: (event) => {
        this.following = false;
        if (event.kind === "history") {
          this.history(event.direction);
          return;
        }
        if (event.kind === "content") {
          this.destination = { id: event.id, offset: 0, end: event.direction === -1 };
        }
        this.changed("content");
      },
    });
    this.transcript.sync();
    this.scroll = new ScrollView(this.transcript, {
      follow: "end",
      primary: false,
      overscroll: "contain",
      scrollbar: "always",
    });
  }
  anchor(): EntryAnchor | undefined {
    return (
      this.destination ??
      (this.following ? undefined : this.transcript.anchor(this.scroll.scrollTop))
    );
  }
  resize(width: number): boolean {
    const changed = this.width >= 100 !== width >= 100;
    this.width = width;
    return changed;
  }
  reveal(anchor: EntryAnchor): void {
    const line = this.transcript.line(anchor);
    const top = line - (anchor.end === true ? this.scroll.viewportHeight : 0);
    const row = line <= 1 && anchor.end !== true && this.scroll.scrollTop === 0;
    this.scroll.scrollTo(row ? 0 : top, { disableFollow: true });
    this.destination = undefined;
  }
  scrollBy(lines: number): void {
    this.following = false;
    this.scroll.scrollTo(this.scroll.scrollTop + lines, { disableFollow: true });
  }
  page(direction: -1 | 1): void {
    this.following = false;
    const height = Math.max(1, this.scroll.viewportHeight);
    if (this.transcript.contentPage(this.scroll.scrollTop, height, direction)) {
      return;
    }
    // A history row keeps a full scroll above line zero; use the actual scroll result.
    const remaining = this.scroll.scrollBy(direction * height);
    if (remaining === 0) {
      return;
    }
    this.history(direction);
  }
  private history(direction: -1 | 1): void {
    const id = this.transcript.history(direction);
    if (id !== undefined) {
      this.destination = {
        id,
        offset: direction < 0 ? -Math.max(1, this.scroll.viewportHeight) : 1,
      };
      this.changed("history");
    }
  }
}
