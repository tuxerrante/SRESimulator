import { describe, expect, it, vi } from "vitest";
import {
  createRequestDeadline,
  RequestDeadlineExceededError,
  waitAtMost,
} from "./request-deadline";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createRequestDeadline", () => {
  it("reports the remaining budget as time elapses", () => {
    let now = 1000;
    const deadline = createRequestDeadline(500, () => now);

    expect(deadline.remainingMs()).toBe(500);
    now = 1200;
    expect(deadline.remainingMs()).toBe(300);
    now = 5000;
    expect(deadline.remainingMs()).toBe(0);
  });

  it("caps a stage budget by the remaining budget minus the reserve", () => {
    let now = 0;
    const deadline = createRequestDeadline(10000, () => now);

    expect(deadline.budgetFor(12000, 8000)).toBe(2000);
    expect(deadline.budgetFor(1000, 8000)).toBe(1000);
    now = 9000;
    expect(deadline.budgetFor(12000, 8000)).toBe(-7000);
  });

  it("throws once the budget is exhausted", () => {
    let now = 0;
    const deadline = createRequestDeadline(100, () => now);

    expect(() => deadline.assertRemaining("stage")).not.toThrow();
    now = 100;
    expect(() => deadline.assertRemaining("stage")).toThrow(RequestDeadlineExceededError);
  });

  it("resolves work that finishes inside the budget", async () => {
    const deadline = createRequestDeadline(1000);

    await expect(deadline.waitWithin("stage", Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("propagates work rejections without converting them to deadline errors", async () => {
    const deadline = createRequestDeadline(1000);
    const failure = new Error("store failed");

    await expect(deadline.waitWithin("stage", Promise.reject(failure))).rejects.toBe(failure);
  });

  it("stops waiting at the budget and reports the late result for compensation", async () => {
    vi.useFakeTimers();
    try {
      const deadline = createRequestDeadline(50);
      const work = deferred<boolean>();
      const onLateSettle = vi.fn();

      const pending = deadline.waitWithin("anonymous-claim-reservation", work.promise, {
        onLateSettle,
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(RequestDeadlineExceededError);

      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(onLateSettle).not.toHaveBeenCalled();

      work.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onLateSettle).toHaveBeenCalledWith(true, undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start waiting when the reserve already consumed the budget", async () => {
    const deadline = createRequestDeadline(1000);
    const work = deferred<string>();
    const onLateSettle = vi.fn();

    await expect(
      deadline.waitWithin("stage", work.promise, { reserveMs: 1000, onLateSettle }),
    ).rejects.toBeInstanceOf(RequestDeadlineExceededError);

    work.resolve("late");
    await Promise.resolve();
    expect(onLateSettle).toHaveBeenCalledWith("late", undefined);
  });

  it("exposes the stage that exceeded the deadline", async () => {
    const deadline = createRequestDeadline(1000);

    await deadline
      .waitWithin("session-create", deferred<string>().promise, { reserveMs: 1000 })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(RequestDeadlineExceededError);
        expect((error as RequestDeadlineExceededError).stage).toBe("session-create");
        expect((error as RequestDeadlineExceededError).totalMs).toBe(1000);
      });
  });
});

describe("waitAtMost", () => {
  it("returns true when cleanup completes inside its own budget", async () => {
    await expect(waitAtMost(Promise.resolve(), 1000)).resolves.toBe(true);
  });

  it("returns true when cleanup fails inside its own budget", async () => {
    await expect(waitAtMost(Promise.reject(new Error("nope")), 1000)).resolves.toBe(true);
  });

  it("returns false without aborting cleanup that overruns its budget", async () => {
    vi.useFakeTimers();
    try {
      const work = deferred<void>();
      let completed = false;
      const tracked = work.promise.then(() => {
        completed = true;
      });

      const pending = waitAtMost(tracked, 20);
      await vi.advanceTimersByTimeAsync(30);
      await expect(pending).resolves.toBe(false);

      work.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("waitWithin external abort", () => {
  it("stops waiting immediately when the abort signal fires", async () => {
    const deadline = createRequestDeadline(10_000);
    const controller = new AbortController();
    const work = deferred<string>();
    const lateSettles: string[] = [];

    const pending = deadline.waitWithin("stage", work.promise, {
      abortSignal: controller.signal,
      onLateSettle: (result) => {
        lateSettles.push(String(result));
      },
    });

    const reason = new Error("client disconnected");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    work.resolve("late");
    await Promise.resolve();
    await Promise.resolve();
    expect(lateSettles).toEqual(["late"]);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const deadline = createRequestDeadline(10_000);
    const work = deferred<string>();

    const reason = new Error("client disconnected");
    await expect(
      deadline.waitWithin("stage", work.promise, {
        abortSignal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);

    work.resolve("ignored");
  });
});
