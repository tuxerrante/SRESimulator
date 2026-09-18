import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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

  it("serves concurrent first-time readers without a partially written file", async () => {
    // The store used to seed the file with a non-atomic writeFile whenever it
    // was missing. Concurrent cold-start readers could observe the file after
    // creation but before its bytes landed and fail with
    // "Unexpected end of JSON input".
    const stores = Array.from({ length: 24 }, () => new JsonAnonymousTrialStore());

    const results = await Promise.all(
      stores.map((store) => store.hasActiveClaim("cold-start")),
    );

    expect(results).toEqual(results.map(() => false));
  });

  // The test above reproduces the original symptom. This one locks the
  // property that removes it: a read must not create the file at all. Against
  // the unfixed store it fails on the existsSync assertion and not with
  // "Unexpected end of JSON input" -- a lone reader there seeds "[]" and then
  // parses it happily. That difference is the point: no seeding write means no
  // window in which another reader can observe a half-written file.
  it("reads an empty claim set before the backing file exists", async () => {
    const store = new JsonAnonymousTrialStore();

    await expect(store.hasActiveClaim("never-written")).resolves.toBe(false);
    expect(existsSync(join(dataDir, "anonymous-trial-claims.json"))).toBe(false);
  });
});
