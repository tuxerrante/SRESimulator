import type { Pool, PoolConfig, QueryResultRow } from "pg";

/**
 * Neon's free plan allows 0.5 GB and autosuspends compute after 5 minutes of
 * idleness, which cannot be disabled. Everything here is shaped by that:
 * a small pool, a connect timeout long enough to absorb a cold start, and a
 * one-shot retry — for reads only — of the connection the suspend killed
 * underneath us.
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
 * Run a query without any automatic retry.
 *
 * This is the default because a dropped connection does not tell the client
 * whether the server committed. Replaying a write that already landed either
 * duplicates it or turns it into a unique-violation the caller never provoked,
 * and the pool reconnects for the next request anyway — so a write that races a
 * Neon suspend surfaces one honest error rather than a silent double effect.
 *
 * Reads go through {@link pgReadQuery}, which is where the retry lives.
 */
export async function pgQuery<R extends QueryResultRow>(
  pool: PgQueryable,
  text: string,
  values?: unknown[],
): Promise<PgQueryResult<R>> {
  return pool.query<R>(text, values);
}

/**
 * A statement that reaches the database only to read it. `WITH` is allowed
 * because the analytics query is a CTE chain, but a data-modifying CTE
 * (`WITH ... AS (INSERT ...)`) is still a write and is caught by the second
 * test rather than by the leading keyword.
 *
 * Word boundaries keep the column names this schema actually uses — and
 * `created_at`, `updated_at`, `is_deleted` — from reading as write keywords,
 * because each continues into another word character.
 */
const READ_STATEMENT_START = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(select|with)\b/i;
const WRITE_KEYWORD =
  /\b(insert|update|delete|merge|truncate|create|drop|alter|grant|revoke|call)\b/i;

export function isReadOnlyStatement(text: string): boolean {
  return READ_STATEMENT_START.test(text) && !WRITE_KEYWORD.test(text);
}

/**
 * Run a read, retrying once if the connection was torn down underneath us.
 *
 * Neon drops idle server connections whenever compute suspends, so the first
 * query after five idle minutes routinely fails on a connection that was alive
 * when it was checked out. Replaying a read is free: it cannot have committed
 * anything, so the worst case is the same rows a moment later.
 *
 * The statement is checked rather than trusted. Routing a write through here is
 * exactly the mistake this split exists to prevent, and it would otherwise be
 * invisible until a suspend happened to land mid-write in production.
 */
export async function pgReadQuery<R extends QueryResultRow>(
  pool: PgQueryable,
  text: string,
  values?: unknown[],
): Promise<PgQueryResult<R>> {
  if (!isReadOnlyStatement(text)) {
    throw new Error(
      "pgReadQuery refuses a statement that is not read-only; use pgQuery, " +
        "which does not retry, so a committed write cannot be replayed.",
    );
  }

  try {
    return await pool.query<R>(text, values);
  } catch (error) {
    if (!isRetryableConnectionError(error)) {
      throw error;
    }
    console.warn("[storage] retrying Postgres read after a dropped connection");
    return pool.query<R>(text, values);
  }
}
