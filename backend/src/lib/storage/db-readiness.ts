import { pingDatabase } from "./index";

/**
 * Optional database check for `/readyz`.
 *
 * `/readyz` is AI-config-only by default, and that default is deliberate:
 * Neon's free plan autosuspends compute after five minutes of idleness and the
 * setting cannot be disabled, so an unconditional `SELECT 1` on a probe that
 * fires every ten seconds keeps the compute awake around the clock and spends
 * the whole monthly CU allowance on liveness.
 *
 * `READYZ_DB_CHECK_INTERVAL_MS` is therefore a *minimum spacing* rather than a
 * poll interval: within the window the last verdict is replayed with no
 * traffic at all, so the probe's own frequency stops deciding how often the
 * database is touched. `0` (the default) switches the check off entirely.
 */

export type DbReadiness =
  /** `READYZ_DB_CHECK_INTERVAL_MS` is unset or zero. */
  | { state: "disabled" }
  /** Checking is enabled but the active backend has no database (JSON mode). */
  | { state: "skipped" }
  | { state: "ok"; checkedAtMs: number; cached: boolean }
  | { state: "failed"; checkedAtMs: number; cached: boolean; error: string };

type CachedResult = Extract<DbReadiness, { state: "ok" | "failed" | "skipped" }>;

let cached: { result: CachedResult; atMs: number } | undefined;
let inFlight: Promise<CachedResult> | undefined;

function readIntervalMs(): number {
  const raw = process.env.READYZ_DB_CHECK_INTERVAL_MS;
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

async function runCheck(nowMs: number): Promise<CachedResult> {
  try {
    const hasDatabase = await pingDatabase();
    if (!hasDatabase) return { state: "skipped" };
    return { state: "ok", checkedAtMs: nowMs, cached: false };
  } catch (error) {
    return {
      state: "failed",
      checkedAtMs: nowMs,
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getDbReadiness(): Promise<DbReadiness> {
  const intervalMs = readIntervalMs();
  if (intervalMs <= 0) return { state: "disabled" };

  const nowMs = Date.now();
  if (cached && nowMs - cached.atMs < intervalMs) {
    const result = cached.result;
    return result.state === "skipped" ? result : { ...result, cached: true };
  }

  // Coalesce concurrent probes. Kubernetes runs readiness and startup probes
  // independently, and a cold Neon endpoint can hold a connection attempt for
  // the full connect timeout, which is long enough for several probes to pile
  // up behind the same query.
  if (!inFlight) {
    inFlight = runCheck(nowMs).then((result) => {
      cached = { result, atMs: Date.now() };
      inFlight = undefined;
      return result;
    });
  }

  return inFlight;
}
