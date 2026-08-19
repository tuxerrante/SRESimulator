interface WithAbortTimeoutOptions {
  suppressAbortErrorAfterTimeout?: boolean;
  /**
   * Aborts the work before the timeout, e.g. when the client disconnects.
   */
  abortSignal?: AbortSignal;
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export async function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  createTimeoutError: (timeoutMs: number) => Error,
  options?: WithAbortTimeoutOptions,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const timeoutError = createTimeoutError(timeoutMs);
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);

    const external = options?.abortSignal;
    const onExternalAbort = () => {
      clearTimeout(timer);
      const abortError = external?.reason;
      controller.abort(abortError);
      reject(abortError instanceof Error ? abortError : new Error("Aborted"));
    };
    if (external) {
      if (external.aborted) {
        onExternalAbort();
        return;
      }
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    };

    run(controller.signal).then(
      (value) => {
        cleanup();
        if (!timedOut) {
          resolve(value);
        }
      },
      (error) => {
        cleanup();
        if (
          timedOut &&
          options?.suppressAbortErrorAfterTimeout &&
          isAbortLikeError(error)
        ) {
          return;
        }
        reject(error);
      },
    );
  });
}
