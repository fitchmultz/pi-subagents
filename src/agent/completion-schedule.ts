/** The three timer kinds completion reconciliation uses, cleared together by their owner. */
export class CompletionSchedule {
  private poll?: NodeJS.Timeout | undefined;
  private hint?: NodeJS.Immediate | undefined;
  private probe?: NodeJS.Timeout | undefined;
  private readonly scan: () => void;
  private readonly checkHints: () => void;
  constructor(scan: () => void, checkHints: () => void) {
    this.scan = scan;
    this.checkHints = checkHints;
  }
  /** One coalesced reconcile for every hint published before it runs. */
  wake(): void {
    this.hint ??= setImmediate(() => {
      this.hint = undefined;
      this.scan();
    }).unref();
  }
  cancelPoll(): void {
    clearTimeout(this.poll);
    this.poll = undefined;
  }
  pollIn(ms: number): void {
    this.cancelPoll();
    this.poll = setTimeout(this.scan, ms).unref();
  }
  /** Recovers change hints the operating system dropped. */
  probeIn(ms: number): void {
    clearInterval(this.probe);
    this.probe = setInterval(this.checkHints, ms).unref();
  }
  cancel(): void {
    this.cancelPoll();
    clearInterval(this.probe);
    this.probe = undefined;
    clearImmediate(this.hint);
    this.hint = undefined;
  }
}
