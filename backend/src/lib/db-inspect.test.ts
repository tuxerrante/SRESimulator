import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(process.cwd(), "../scripts/db-inspect.cjs");

async function createFakeMssqlModule(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "db-inspect-test-"));
  const moduleDir = path.join(tempDir, "mssql");
  await mkdir(moduleDir, { recursive: true });

  await writeFile(
    path.join(moduleDir, "index.js"),
    `let connectAttempts = 0;

class FakeRequest {
  input() {
    return this;
  }

  async query(sql) {
    if (sql.includes("COL_LENGTH('sessions', 'traffic_source')")) {
      if (process.env.MSSQL_FAKE_EXPECT_PLAYER_COMPLETION === "legacy") {
        return { recordset: [{ has_traffic_source: 0 }] };
      }

      if (process.env.MSSQL_FAKE_EXPECT_PLAYER_COMPLETION === "1") {
        return { recordset: [{ has_traffic_source: 1 }] };
      }
    }

    if (process.env.MSSQL_FAKE_EXPECT_PLAYER_COMPLETION === "1") {
      if (
        sql.includes("FROM sessions") &&
        sql.includes("traffic_source = 'player'") &&
        sql.includes("SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END)")
      ) {
        return { recordset: [
          { difficulty: "hard", attempts: 10, completions: 3, completion_pct: "30.00" },
        ] };
      }

      throw new Error("unexpected SQL for player completion report");
    }

    if (process.env.MSSQL_FAKE_EXPECT_PLAYER_COMPLETION === "legacy") {
      if (
        sql.includes("FROM sessions") &&
        !sql.includes("traffic_source = 'player'") &&
        sql.includes("SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END)")
      ) {
        return { recordset: [
          { difficulty: "hard", attempts: 10, completions: 3, completion_pct: "30.00" },
        ] };
      }

      throw new Error("unexpected SQL for legacy player completion report");
    }

    if (sql.includes("COUNT(*) AS [rows]")) {
      return { recordset: [
        { table: "sessions", rows: 3 },
        { table: "leaderboard_entries", rows: 2 },
        { table: "gameplay_metrics", rows: 1 },
      ] };
    }

    return { recordset: [] };
  }
}

class ConnectionPool {
  constructor(_url) {}

  async connect() {
    connectAttempts += 1;
    if (process.env.MSSQL_FAKE_FAIL_CONNECT_ONCE === "1" && connectAttempts === 1) {
      const error = new Error("Failed to connect to fake.database.windows.net:1433 in 15000ms");
      error.code = "ETIMEOUT";
      throw error;
    }
  }

  request() {
    return new FakeRequest();
  }

  async close() {}
}

module.exports = { ConnectionPool };
`,
    "utf8",
  );

  return tempDir;
}

describe("db-inspect CLI", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("retries a transient SQL connect timeout and still prints inspection output", async () => {
    const fakeNodePath = await createFakeMssqlModule();
    tempDirs.push(fakeNodePath);

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        DATABASE_URL: "Server=fake;Database=test;",
        NODE_PATH: fakeNodePath,
        MSSQL_FAKE_FAIL_CONNECT_ONCE: "1",
      },
    });

    expect(stdout).toContain("Table Row Counts");
    expect(stdout).toContain("Recent Gameplay Metrics");
  });

  it("prints the built-in player completion report when requested", async () => {
    const fakeNodePath = await createFakeMssqlModule();
    tempDirs.push(fakeNodePath);

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        DATABASE_URL: "Server=fake;Database=test;",
        NODE_PATH: fakeNodePath,
        REPORT: "player-completion",
        MSSQL_FAKE_EXPECT_PLAYER_COMPLETION: "1",
      },
    });

    expect(stdout).toContain("Player Completion Stats");
    expect(stdout).toContain("hard");
    expect(stdout).toContain("30.00");
  });

  it("falls back to unfiltered completion stats when traffic_source is not deployed yet", async () => {
    const fakeNodePath = await createFakeMssqlModule();
    tempDirs.push(fakeNodePath);

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        DATABASE_URL: "Server=fake;Database=test;",
        NODE_PATH: fakeNodePath,
        REPORT: "player-completion",
        MSSQL_FAKE_EXPECT_PLAYER_COMPLETION: "legacy",
      },
    });

    expect(stdout).toContain("Player Completion Stats");
    expect(stdout).toContain("traffic_source column not found");
    expect(stdout).toContain("hard");
  });

  it("prints the unknown report error with a single db-inspect prefix", async () => {
    const fakeNodePath = await createFakeMssqlModule();
    tempDirs.push(fakeNodePath);

    await expect(
      execFileAsync(process.execPath, [SCRIPT_PATH], {
        env: {
          ...process.env,
          DATABASE_URL: "Server=fake;Database=test;",
          NODE_PATH: fakeNodePath,
          REPORT: "unknown-report",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("[db-inspect] Unknown REPORT 'unknown-report'."),
    });

    await expect(
      execFileAsync(process.execPath, [SCRIPT_PATH], {
        env: {
          ...process.env,
          DATABASE_URL: "Server=fake;Database=test;",
          NODE_PATH: fakeNodePath,
          REPORT: "unknown-report",
        },
      }),
    ).rejects.not.toMatchObject({
      stderr: expect.stringContaining("[db-inspect] [db-inspect] Unknown REPORT 'unknown-report'."),
    });
  });
});
