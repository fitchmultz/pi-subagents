import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../shared/types.ts";

/** One owner identity and cancellation generation shared by asynchronous UI observations/actions. */
export class ViewSession {
  ctx?: ExtensionContext;
  ownerSessionId?: string;
  generation = 0;
  private pending = new AbortController();
  private readonly state: SubagentState;
  constructor(state: SubagentState) {
    this.state = state;
  }
  context(): ExtensionContext {
    if (!this.ctx) {
      throw new Error("The owning session is no longer available.");
    }
    return this.ctx;
  }
  get signal(): AbortSignal {
    return this.pending.signal;
  }
  start(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.ownerSessionId = ctx.sessionManager.getSessionId();
    this.pending = new AbortController();
  }
  live(generation = this.generation): boolean {
    return (
      generation === this.generation &&
      this.ctx !== undefined &&
      this.ctx.sessionManager.getSessionId() === this.ownerSessionId &&
      this.state.lastUiContext?.sessionManager.getSessionId() === this.ownerSessionId
    );
  }
  dispose(): void {
    this.generation++;
    this.pending.abort();
    this.ctx = undefined;
    this.ownerSessionId = undefined;
  }
}
