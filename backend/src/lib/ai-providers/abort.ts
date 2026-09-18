export const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 8000;

export function retryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = parseFloat(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
  }
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * RETRY_BASE_DELAY_MS;
  return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
}

export function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "The operation was aborted.");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw toAbortError(signal.reason);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(toAbortError(signal.reason));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(toAbortError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function raceWithAbort<T>(operation: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  const operationPromise = Promise.resolve(operation);
  if (!signal) {
    return operationPromise;
  }
  if (signal.aborted) {
    return Promise.reject(toAbortError(signal.reason));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(toAbortError(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    operationPromise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
