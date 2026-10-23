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
  constructor(
    watch: Watch,
    options: { tui: TUI; hideThinking: boolean; changed: () => void; loaded: () => void },
  ) {
    this.watch = watch;
    const { sessionFile: file, sessionId, cwd } = watch.launch;
    this.transcript = new ObserverTranscript({
      ...options,
      file,
      sessionId,
      cwd,
      changed: (id, direction, gap) => {
        this.following = false;
        if (id !== undefined) {
          const offset = gap === true ? -this.scroll.viewportHeight : 0;
          this.destination = { id, offset, end: gap !== true && direction === -1 };
        }
        options.changed();
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
    this.scroll.scrollTo(
      this.transcript.line(anchor) - (anchor.end === true ? this.scroll.viewportHeight : 0),
      { disableFollow: true },
    );
    this.destination = undefined;
  }
  scrollBy(lines: number): void {
    this.following = false;
    this.scroll.scrollTo(this.scroll.scrollTop + lines, { disableFollow: true });
  }
  page(direction: number): boolean {
    this.following = false;
    const height = Math.max(1, this.scroll.viewportHeight);
    if (this.transcript.contentPage(this.scroll.scrollTop, height, direction)) {
      return false;
    }
    // A history row keeps a full scroll above line zero; use the actual scroll result.
    const remaining = this.scroll.scrollBy(direction * height);
    if (remaining === 0) {
      return false;
    }
    const id = this.transcript.history(direction);
    if (id !== undefined) {
      this.destination = { id, offset: direction < 0 ? -height : 1 };
      return true;
    }
    return false;
  }
}
