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
