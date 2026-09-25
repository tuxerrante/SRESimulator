import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The property these tests exist for is a cost property, not a correctness
 * one: Neon bills compute time, its free plan autosuspends after five minutes
 * of idleness, and the setting cannot be turned off. A `/readyz` that pings the
 * database every ten seconds therefore spends the entire monthly allowance
 * keeping an idle demo awake. So "off by default" and "one query per interval,
 * however often the probe fires" are both asserted against the number of times
 * the driver was actually called, not against what the endpoint reports.
 */

const ping = vi.fn<() => Promise<boolean>>();

async function loadModule() {
  vi.resetModules();
  vi.doMock("./index", () => ({ pingDatabase: ping }));
  return import("./db-readiness");
}

describe("db-readiness", () => {
  const originalInterval = process.env.READYZ_DB_CHECK_INTERVAL_MS;

  beforeEach(() => {
    ping.mockReset();
    ping.mockResolvedValue(true);
    delete process.env.READYZ_DB_CHECK_INTERVAL_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("./index");
    if (originalInterval === undefined) {
      delete process.env.READYZ_DB_CHECK_INTERVAL_MS;
    } else {
      process.env.READYZ_DB_CHECK_INTERVAL_MS = originalInterval;
    }
  });

  it("is off when READYZ_DB_CHECK_INTERVAL_MS is unset, and issues no query", async () => {
    const { getDbReadiness } = await loadModule();

    await expect(getDbReadiness()).resolves.toEqual({ state: "disabled" });
    expect(ping).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "not-a-number", ""])(
    "treats %j as off rather than as an unbounded check",
    async (value) => {
      process.env.READYZ_DB_CHECK_INTERVAL_MS = value;
      const { getDbReadiness } = await loadModule();

      await expect(getDbReadiness()).resolves.toEqual({ state: "disabled" });
      expect(ping).not.toHaveBeenCalled();
    }
  );

  it("reports skipped when the active backend has no database", async () => {
    process.env.READYZ_DB_CHECK_INTERVAL_MS = "30000";
    ping.mockResolvedValue(false);
    const { getDbReadiness } = await loadModule();

    await expect(getDbReadiness()).resolves.toEqual({ state: "skipped" });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("replays the verdict within the interval instead of querying again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    process.env.READYZ_DB_CHECK_INTERVAL_MS = "30000";
    const { getDbReadiness } = await loadModule();

    const first = await getDbReadiness();
    vi.setSystemTime(new Date("2026-09-21T00:00:29Z"));
    const second = await getDbReadiness();

    expect(first).toMatchObject({ state: "ok", cached: false });
    expect(second).toMatchObject({ state: "ok", cached: true });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("queries again once the interval has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    process.env.READYZ_DB_CHECK_INTERVAL_MS = "30000";
    const { getDbReadiness } = await loadModule();

    await getDbReadiness();
    vi.setSystemTime(new Date("2026-09-21T00:00:31Z"));
    const second = await getDbReadiness();

    expect(second).toMatchObject({ state: "ok", cached: false });
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent probes into one query", async () => {
    process.env.READYZ_DB_CHECK_INTERVAL_MS = "30000";
    let release: (value: boolean) => void = () => {};
    ping.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    const { getDbReadiness } = await loadModule();

    const all = Promise.all([getDbReadiness(), getDbReadiness(), getDbReadiness()]);
    release(true);

    for (const result of await all) {
      expect(result).toMatchObject({ state: "ok" });
    }
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("reports the driver's message when the query fails", async () => {
    process.env.READYZ_DB_CHECK_INTERVAL_MS = "30000";
    ping.mockRejectedValue(new Error("terminating connection due to administrator command"));
    const { getDbReadiness } = await loadModule();

    await expect(getDbReadiness()).resolves.toMatchObject({
      state: "failed",
      error: "terminating connection due to administrator command",
    });
  });

  it("does not retry a failure until the interval has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    process.env.READYZ_DB_CHECK_INTERVAL_MS = "30000";
    ping.mockRejectedValue(new Error("ECONNREFUSED"));
    const { getDbReadiness } = await loadModule();

    await getDbReadiness();
    vi.setSystemTime(new Date("2026-09-21T00:00:10Z"));
    const second = await getDbReadiness();

    expect(second).toMatchObject({ state: "failed", cached: true });
    expect(ping).toHaveBeenCalledTimes(1);
  });
});
