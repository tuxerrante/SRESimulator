import { readFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

describe("traffic source migration", () => {
  it("uses dynamic SQL for updates that reference newly added columns", async () => {
    const migrationPath = path.join(__dirname, "migrations", "004_traffic_source.sql");
    const sql = await readFile(migrationPath, "utf-8");

    expect(sql).not.toMatch(/^\s*UPDATE\s+sessions\s+SET\s+traffic_source/m);
    expect(sql).not.toMatch(/^\s*UPDATE\s+gameplay_metrics\s+SET\s+traffic_source/m);
    expect(sql).not.toMatch(/^\s*UPDATE\s+leaderboard_entries\s+SET\s+traffic_source/m);

    expect(sql).toContain("EXEC('UPDATE sessions");
    expect(sql).toContain("EXEC('UPDATE gameplay_metrics");
    expect(sql).toContain("EXEC('UPDATE leaderboard_entries");
  });
});

describe("GitHub login nickname migration", () => {
  it("rebuilds the nickname index before widening the telemetry column", async () => {
    const migrationPath = path.join(
      __dirname,
      "migrations",
      "007_github_login_nickname_length.sql",
    );
    const sql = await readFile(migrationPath, "utf-8");

    expect(sql).toContain("DROP INDEX idx_metrics_nickname ON gameplay_metrics");
    expect(sql).toContain("ALTER COLUMN nickname NVARCHAR(39) NULL");
    expect(sql).toContain("CREATE INDEX idx_metrics_nickname ON gameplay_metrics (nickname)");
  });
});
