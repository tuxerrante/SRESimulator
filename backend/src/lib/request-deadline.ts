export class RequestDeadlineExceededError extends Error {
  readonly stage: string;
  readonly totalMs: number;

  constructor(stage: string, totalMs: number) {
    super(`Request deadline of ${totalMs}ms exceeded at stage ${stage}`);
    this.name = "RequestDeadlineExceededError";
    this.stage = stage;
    this.totalMs = totalMs;
  }
}

export interface WaitWithinOptions<T> {
  /**
   * Budget held back for the stages that still have to run after this one.
   */
  reserveMs?: number;
  /**
   * Stops waiting early, e.g. when the client disconnects. The underlying work
   * is not aborted, so `onLateSettle` still applies.
   */
  abortSignal?: AbortSignal;
  /**
   * Compensating action invoked when the work settles after the deadline was
   * already reported. The underlying work is never aborted, so state mutations
   * still complete and can be rolled back here.
   */
  onLateSettle?: (result: T | undefined, error: unknown) => void;
}

export interface StageTiming {
  stage: string;
  durationMs: number;
  outcome: "ok" | "failed" | "deadline-exceeded";
}

export interface RequestDeadline {
  readonly totalMs: number;
  remainingMs(): number;
  elapsedMs(): number;
  budgetFor(stageMs: number, reserveMs?: number): number;
  assertRemaining(stage: string, minMs?: number): void;
  waitWithin<T>(stage: string, work: Promise<T>, options?: WaitWithinOptions<T>): Promise<T>;
  recordStage(stage: string, durationMs: number, outcome: StageTiming["outcome"]): void;
  timings(): StageTiming[];
}

export function createRequestDeadline(totalMs: number, now: () => number = Date.now): RequestDeadline {
  const startedAt = now();
  const stageTimings: StageTiming[] = [];
  const elapsedMs = (): number => now() - startedAt;
  const remainingMs = (): number => Math.max(0, totalMs - elapsedMs());

  const recordStage = (
    stage: string,
    durationMs: number,
    outcome: StageTiming["outcome"],
  ): void => {
    stageTimings.push({ stage, durationMs, outcome });
  };

  const budgetFor = (stageMs: number, reserveMs = 0): number =>
    Math.min(stageMs, remainingMs() - reserveMs);

  const assertRemaining = (stage: string, minMs = 1): void => {
    if (remainingMs() < minMs) {
      throw new RequestDeadlineExceededError(stage, totalMs);
    }
  };

  const waitWithin = <T>(
    stage: string,
    work: Promise<T>,
    options?: WaitWithinOptions<T>,
  ): Promise<T> => {
    const stageStartedAt = now();
    const budget = budgetFor(Number.POSITIVE_INFINITY, options?.reserveMs ?? 0);
    if (budget <= 0) {
      recordStage(stage, 0, "deadline-exceeded");
      work.then(
        (result) => options?.onLateSettle?.(result, undefined),
        (error) => options?.onLateSettle?.(undefined, error),
      );
      return Promise.reject(new RequestDeadlineExceededError(stage, totalMs));
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timerRef: { current?: ReturnType<typeof setTimeout> } = {};
      const external = options?.abortSignal;
      const attachLateSettle = (): void => {
        work.then(
          (result) => options?.onLateSettle?.(result, undefined),
          (error) => options?.onLateSettle?.(undefined, error),
        );
      };
      const cleanup = (): void => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        external?.removeEventListener("abort", onExternalAbort);
      };
      function onExternalAbort(): void {
        settled = true;
        cleanup();
        recordStage(stage, now() - stageStartedAt, "failed");
        const reason = external?.reason;
        reject(reason instanceof Error ? reason : new Error("Aborted"));
      }

      if (external?.aborted) {
        onExternalAbort();
        attachLateSettle();
        return;
      }
      external?.addEventListener("abort", onExternalAbort, { once: true });

      timerRef.current = setTimeout(() => {
        settled = true;
        cleanup();
        recordStage(stage, now() - stageStartedAt, "deadline-exceeded");
        reject(new RequestDeadlineExceededError(stage, totalMs));
      }, budget);

      work.then(
        (result) => {
          cleanup();
          if (settled) {
            options?.onLateSettle?.(result, undefined);
            return;
          }
          settled = true;
          recordStage(stage, now() - stageStartedAt, "ok");
          resolve(result);
        },
        (error) => {
          cleanup();
          if (settled) {
            options?.onLateSettle?.(undefined, error);
            return;
          }
          settled = true;
          recordStage(stage, now() - stageStartedAt, "failed");
          reject(error);
        },
      );
    });
  };

  return {
    totalMs,
    remainingMs,
    elapsedMs,
    budgetFor,
    assertRemaining,
    waitWithin,
    recordStage,
    timings: () => [...stageTimings],
  };
}

/**
 * Waits for cleanup work on an independent budget so failure latency is not
 * charged to the request deadline. The work is never aborted.
 */
export async function waitAtMost(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = work.then(
    () => true,
    () => true,
  );
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  const completed = await Promise.race([guarded, timedOut]);
  if (timer) {
    clearTimeout(timer);
  }
  return completed;
}
