interface Request {
  readonly reject: (error: Readonly<Error>) => void;
}

/** Map membership owns settlement; taking a request also releases its deadline. */
export class PendingRequests<T extends Request> {
  private readonly pending = new Map<
    string,
    { readonly value: T; readonly timer: NodeJS.Timeout }
  >();

  get(id: string): T | undefined {
    return this.pending.get(id)?.value;
  }

  set(id: string, value: T, timeoutMs: number, timeoutError: () => Error): void {
    const timer = setTimeout(() => this.take(id)?.reject(timeoutError()), timeoutMs);
    timer.unref();
    this.pending.set(id, { value, timer });
  }

  take(id: string): T | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    return pending.value;
  }

  fail(error: Readonly<Error>): void {
    for (const id of this.pending.keys()) {
      this.take(id)?.reject(error);
    }
  }
}
