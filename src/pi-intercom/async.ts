/** Bounded observation; the caller continues to own the underlying operation. */
export async function settleWithin<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          finish(value);
        },
        () => {
          finish(null);
        },
      )
      .catch(() => {
        // Both terminal handlers are synchronous; retain rejection ownership if a native timer fails.
        finish(null);
      });
  });
}
