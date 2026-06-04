interface WithAbortTimeoutOptions {
  suppressAbortErrorAfterTimeout?: boolean;
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

    run(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        if (!timedOut) {
          resolve(value);
        }
      },
      (error) => {
        clearTimeout(timer);
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
