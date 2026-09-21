import type { Pool, PoolConfig, QueryResultRow } from "pg";

/**
 * Neon's free plan allows 0.5 GB and autosuspends compute after 5 minutes of
 * idleness, which cannot be disabled. Everything here is shaped by that:
 * a small pool, a connect timeout long enough to absorb a cold start, and a
 * one-shot retry for the connection the suspend killed underneath us.
 */
const DEFAULT_MAX_CLIENTS = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/** Postgres SQLSTATE for "terminating connection due to administrator command". */
const ADMIN_SHUTDOWN = "57P01";
/** SQLSTATE for "terminating connection due to crash of another server process". */
const CRASH_SHUTDOWN = "57P02";

const RETRYABLE_SQLSTATES = new Set([ADMIN_SHUTDOWN, CRASH_SHUTDOWN]);
const RETRYABLE_SYSCALL_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT"]);

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Append `statement_timeout` to the connection string rather than issuing a
 * runtime `SET`. Neon's pooled endpoint is PgBouncer in transaction mode, which
 * does not preserve session state between transactions, so a `SET` would apply
 * to whichever backend happened to serve that one statement. The `options`
 * startup parameter is sent at connection time and therefore survives.
 *
 * An operator-supplied `options` is left alone: they have been explicit.
 */
export function withStatementTimeout(databaseUrl: string, timeoutMs: number): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Not a URL we can rewrite (libpq keyword/value form). Leave it untouched;
    // the operator keeps whatever they configured.
    return databaseUrl;
  }

  if (url.searchParams.has("options")) {
    return databaseUrl;
  }

  url.searchParams.set("options", `-c statement_timeout=${timeoutMs}`);
  return url.toString();
}

export function buildPgPoolConfig(databaseUrl: string): PoolConfig {
  const statementTimeoutMs = readPositiveInt(
    "PG_STATEMENT_TIMEOUT_MS",
    DEFAULT_STATEMENT_TIMEOUT_MS,
  );

  return {
    connectionString: withStatementTimeout(databaseUrl, statementTimeoutMs),
    max: readPositiveInt("PG_POOL_MAX", DEFAULT_MAX_CLIENTS),
    idleTimeoutMillis: readPositiveInt("PG_POOL_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: readPositiveInt(
      "PG_POOL_CONNECT_TIMEOUT_MS",
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    keepAlive: true,
  };
}

/**
 * Attach the idle-client error handler.
 *
 * This is not optional. `pg` re-emits errors from idle pooled clients on the
 * Pool itself, and an `error` event with no listener is an unhandled exception
 * that takes the Node process down. Neon drops idle server connections whenever
 * compute suspends, so without this the backend crashes after five idle
 * minutes — the single most likely production incident on this path.
 */
export function attachPoolErrorHandler(pool: Pool): void {
  pool.on("error", (error) => {
    console.error("[storage] idle Postgres client error (pool will reconnect)", error);
  });
}

function isRetryableConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") {
    return false;
  }

  return RETRYABLE_SQLSTATES.has(code) || RETRYABLE_SYSCALL_CODES.has(code);
}

export interface PgQueryResult<R extends QueryResultRow> {
  rows: R[];
  rowCount: number | null;
}

export interface PgQueryable {
  query<R extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<PgQueryResult<R>>;
}

/**
 * Run a query, retrying once if the connection was torn down underneath us.
 *
 * Only connection-level failures are retried, and only once: a statement that
 * failed for its own reasons is not made correct by running it again, and every
 * caller here is either read-only or idempotent under a unique constraint.
 */
export async function pgQuery<R extends QueryResultRow>(
  pool: PgQueryable,
  text: string,
  values?: unknown[],
): Promise<PgQueryResult<R>> {
  try {
    return await pool.query<R>(text, values);
  } catch (error) {
    if (!isRetryableConnectionError(error)) {
      throw error;
    }
    console.warn("[storage] retrying Postgres query after a dropped connection");
    return pool.query<R>(text, values);
  }
}
