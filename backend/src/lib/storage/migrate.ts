import { readFile, readdir } from "fs/promises";
import path from "path";
import type sql from "mssql";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export async function runMigrations(pool: sql.ConnectionPool): Promise<void> {
  const request = pool.request();

  // Serialize migrations across replicas via application lock
  await request.query(`
    DECLARE @result INT;
    EXEC @result = sp_getapplock
      @Resource = 'SRESimMigrations',
      @LockMode = 'Exclusive',
      @LockOwner = 'Session',
      @LockTimeout = 30000;
    IF @result < 0
      THROW 50001, 'Could not acquire migration lock', 1;
  `);

  try {
    await request.query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '_migrations')
      CREATE TABLE _migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
      )
    `);

    const applied = await request.query<{ name: string }>(
      "SELECT name FROM _migrations ORDER BY name"
    );
    const appliedSet = new Set(applied.recordset.map((r) => r.name));

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

      const migrationSql = await readFile(path.join(MIGRATIONS_DIR, file), "utf-8");
      console.log(`[migrate] applying ${file}...`);

      const tx = pool.transaction();
      await tx.begin();
      try {
        await tx.request().query(migrationSql);
        await tx.request()
          .input("name", file)
          .query("INSERT INTO _migrations (name) VALUES (@name)");
        await tx.commit();
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await tx.rollback();
        throw new Error(`Migration ${file} failed: ${err}`);
      }
    }
  } finally {
    await request.query(`
      EXEC sp_releaseapplock
        @Resource = 'SRESimMigrations',
        @LockOwner = 'Session';
    `);
  }
}
