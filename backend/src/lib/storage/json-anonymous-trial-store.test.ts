import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonAnonymousTrialStore } from "./json-anonymous-trial-store";

describe("JsonAnonymousTrialStore", () => {
  const originalDataDir = process.env.DATA_DIR;
  const originalLockTimeoutMs =
    process.env.JSON_ANONYMOUS_TRIAL_STORE_LOCK_TIMEOUT_MS;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "json-anonymous-trial-store-"));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (originalLockTimeoutMs === undefined) {
      delete process.env.JSON_ANONYMOUS_TRIAL_STORE_LOCK_TIMEOUT_MS;
    } else {
      process.env.JSON_ANONYMOUS_TRIAL_STORE_LOCK_TIMEOUT_MS =
        originalLockTimeoutMs;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("serializes reservations across store instances", async () => {
    const stores = [
      new JsonAnonymousTrialStore(),
      new JsonAnonymousTrialStore(),
    ];
    const now = Date.now();

    await expect(
      Promise.all(
        stores.map((store, index) =>
          store.reserveClaimKeys(
            [`claim-${index}`],
            {
              claimKey: `claim-${index}`,
              createdAt: now,
              expiresAt: now + 60_000,
            },
          ),
        ),
      ),
    ).resolves.toEqual([true, true]);

    await expect(stores[0].hasActiveClaim("claim-0", now)).resolves.toBe(true);
    await expect(stores[1].hasActiveClaim("claim-1", now)).resolves.toBe(true);
  });

  it("fails fast when a stale anonymous trial lock never clears", async () => {
    process.env.JSON_ANONYMOUS_TRIAL_STORE_LOCK_TIMEOUT_MS = "30";
    await mkdir(join(dataDir, ".anonymous-trial.lock"));
    const store = new JsonAnonymousTrialStore();
    const now = Date.now();

    await expect(
      store.reserveClaimKeys(
        ["stale-lock-claim"],
        {
          claimKey: "stale-lock-claim",
          createdAt: now,
          expiresAt: now + 60_000,
        },
      ),
    ).rejects.toThrow(/Timed out waiting for anonymous trial lock/);
  });
});
