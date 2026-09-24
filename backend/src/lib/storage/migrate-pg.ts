import { readFile, readdir } from "fs/promises";
import path from "path";
import type { Pool } from "pg";

const MIGRATIONS_DIR = path.join(__dirname, "migrations-pg");

/**
 * Stable advisory-lock key for this project's migrations, the Postgres
 * counterpart of MSSQL's `sp_getapplock @Resource = 'SRESimMigrations'`.
 * Arbitrary but fixed: changing it would let two replicas migrate concurrently.
 * Deliberately below 2^53 so it survives a round trip through a JS number; the
 * cast to `bigint` happens in SQL.
 */
const MIGRATION_LOCK_KEY = 7_723_951_146_004_213;

/**
 * PgBouncer note: this uses `pg_advisory_xact_lock`, which is transaction
 * scoped and released by COMMIT/ROLLBACK, so it is safe under transaction
 * pooling. Do not switch to `pg_advisory_lock` — a session-scoped lock would be
 * released onto a connection that PgBouncer has already handed to someone else.
 * The same rule is why nothing in the pg stores uses `SET`, `LISTEN/NOTIFY`, or
 * cross-transaction temp tables.
 */
export async function runPgMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize migrations across replicas. Blocks rather than failing, and is
    // released with the transaction whichever way it ends.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<{ name: string }>(
      "SELECT name FROM _migrations ORDER BY name"
    );
    const appliedSet = new Set(applied.rows.map((r) => r.name));

    let files: string[];
    try {
      files = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith(".sql"))
        .sort();
    } catch (error) {
      // Only a genuinely absent directory gets the build-output hint. A
      // permission or I/O failure reported as "not found" sends the operator
      // looking for a Dockerfile COPY that is already there, so those
      // propagate with their own errno intact.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      throw new Error(
        `Migrations directory not found at ${MIGRATIONS_DIR}. ` +
        "Ensure the .sql files are copied into the build output (e.g. in the Dockerfile)."
      );
    }

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const migrationSql = await readFile(path.join(MIGRATIONS_DIR, file), "utf-8");
      console.log(`[migrate-pg] applying ${file}...`);

      await client.query(migrationSql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      console.log(`[migrate-pg] applied ${file}`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { /* the transaction is already lost */ });
    throw error;
  } finally {
    client.release();
  }
}
