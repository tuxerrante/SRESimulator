#!/usr/bin/env node

const sql = require("mssql");

const databaseUrl = process.env.DATABASE_URL;
const limitRaw = process.env.LIMIT ?? "10";
const customSql = process.env.SQL?.trim() ?? "";
const customSqlUpper = customSql.replace(/^\s+/, "").toUpperCase();

const limit = Number.parseInt(limitRaw, 10);
if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
  console.error("[db-inspect] LIMIT must be an integer between 1 and 200.");
  process.exit(1);
}

if (!databaseUrl) {
  console.error("[db-inspect] DATABASE_URL is required.");
  process.exit(1);
}

if (customSql && !/^(SELECT|WITH)\b/.test(customSqlUpper)) {
  console.error("[db-inspect] SQL must start with SELECT or WITH.");
  process.exit(1);
}

function printSection(title) {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

async function run() {
  const pool = new sql.ConnectionPool(databaseUrl);
  await pool.connect();

  try {
    if (customSql) {
      const result = await pool.request().query(customSql);
      printSection("Custom Query Result");
      console.log(`Rows: ${result.recordset.length}`);
      if (result.recordset.length > 0) {
        console.table(result.recordset);
      }
      return;
    }

    const counts = await pool.request().query(`
      SELECT 'sessions' AS [table], COUNT(*) AS [rows] FROM sessions
      UNION ALL
      SELECT 'leaderboard_entries' AS [table], COUNT(*) AS [rows] FROM leaderboard_entries
      UNION ALL
      SELECT 'gameplay_metrics' AS [table], COUNT(*) AS [rows] FROM gameplay_metrics;
    `);

    printSection("Table Row Counts");
    console.table(counts.recordset);

    const leaderboard = await pool.request()
      .input("limit", limit)
      .query(`
        SELECT TOP (@limit)
          nickname,
          difficulty,
          score_total,
          grade,
          command_count,
          duration_ms,
          scenario_title,
          created_at
        FROM leaderboard_entries
        ORDER BY created_at DESC;
      `);

    printSection(`Recent Leaderboard Entries (top ${limit})`);
    if (leaderboard.recordset.length > 0) {
      console.table(leaderboard.recordset);
    } else {
      console.log("No rows.");
    }

    const sessions = await pool.request()
      .input("limit", limit)
      .query(`
        SELECT TOP (@limit)
          token,
          difficulty,
          scenario_title,
          start_time,
          used,
          created_at
        FROM sessions
        ORDER BY created_at DESC;
      `);

    printSection(`Recent Sessions (top ${limit})`);
    if (sessions.recordset.length > 0) {
      console.table(sessions.recordset);
    } else {
      console.log("No rows.");
    }

    const metrics = await pool.request()
      .input("limit", limit)
      .query(`
        SELECT TOP (@limit)
          id,
          nickname,
          difficulty,
          scenario_title,
          chat_message_count,
          ai_prompt_tokens,
          ai_completion_tokens,
          duration_ms,
          completed,
          created_at
        FROM gameplay_metrics
        ORDER BY created_at DESC;
      `);

    printSection(`Recent Gameplay Metrics (top ${limit})`);
    if (metrics.recordset.length > 0) {
      console.table(metrics.recordset);
    } else {
      console.log("No rows.");
    }
  } finally {
    await pool.close();
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[db-inspect] ${message}`);
  process.exit(1);
});
