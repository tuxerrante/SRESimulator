import { readFile, readdir } from "fs/promises";
import path from "path";
import type { Pool } from "pg";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Serialize migrations across replicas via advisory lock
    await client.query("SELECT pg_advisory_lock(8675309)");

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const { rows: applied } = await client.query<{ name: string }>(
        "SELECT name FROM _migrations ORDER BY name"
      );
      const appliedSet = new Set(applied.map((r) => r.name));

      let files: string[];
      try {
        files = (await readdir(MIGRATIONS_DIR))
          .filter((f) => f.endsWith(".sql"))
          .sort();
      } catch {
        throw new Error(
          `Migrations directory not found at ${MIGRATIONS_DIR}. ` +
          "Ensure .sql files are copied to the build output (e.g. in Dockerfile)."
        );
      }

      for (const file of files) {
        if (appliedSet.has(file)) continue;

        const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf-8");
        console.log(`[migrate] applying ${file}...`);

        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO _migrations (name) VALUES ($1)",
            [file]
          );
          await client.query("COMMIT");
          console.log(`[migrate] applied ${file}`);
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`Migration ${file} failed: ${err}`);
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(8675309)");
    }
  } finally {
    client.release();
  }
}
