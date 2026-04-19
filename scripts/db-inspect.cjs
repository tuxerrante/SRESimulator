#!/usr/bin/env node

const sql = require("mssql");

const databaseUrl = process.env.DATABASE_URL;
const limitRaw = process.env.LIMIT ?? "10";
const customSql = process.env.SQL?.trim() ?? "";
const reportName = process.env.REPORT?.trim() ?? "";
const customSqlUpper = customSql.replace(/^\s+/, "").toUpperCase();
const disallowedSqlPattern =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|EXEC|EXECUTE|TRUNCATE|INTO)\b/;

const limit = Number.parseInt(limitRaw, 10);
if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
  console.error("[db-inspect] LIMIT must be an integer between 1 and 200.");
  process.exit(1);
}

if (!databaseUrl) {
  console.error("[db-inspect] DATABASE_URL is required.");
  process.exit(1);
}

if (customSql && reportName) {
  console.error("[db-inspect] Use either SQL or REPORT, not both.");
  process.exit(1);
}

if (customSql && !/^SELECT\b/.test(customSqlUpper)) {
  console.error("[db-inspect] SQL must start with SELECT.");
  process.exit(1);
}

if (customSql && customSql.includes(";")) {
  console.error("[db-inspect] SQL must be a single statement (semicolon is not allowed).");
  process.exit(1);
}

if (customSql && (/--|\/\*/.test(customSql) || disallowedSqlPattern.test(customSqlUpper))) {
  console.error("[db-inspect] SQL contains disallowed tokens for read-only inspection.");
  process.exit(1);
}

function printSection(title) {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

function getBuiltInReport(report) {
  if (!report) return null;

  if (report === "player-completion") {
    return {
      title: "Player Completion Stats",
      sql: `
        SELECT
          difficulty,
          COUNT(*) AS attempts,
          SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) AS completions,
          CAST(
            100.0 * SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)
            AS DECIMAL(5, 2)
          ) AS completion_pct
        FROM sessions
        WHERE traffic_source = 'player'
        GROUP BY difficulty
        ORDER BY CASE difficulty
          WHEN 'easy' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'hard' THEN 3
          ELSE 4
        END;
      `,
      legacySql: `
        SELECT
          difficulty,
          COUNT(*) AS attempts,
          SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) AS completions,
          CAST(
            100.0 * SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)
            AS DECIMAL(5, 2)
          ) AS completion_pct
        FROM sessions
        GROUP BY difficulty
        ORDER BY CASE difficulty
          WHEN 'easy' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'hard' THEN 3
          ELSE 4
        END;
      `,
    };
  }

  throw new Error(`[db-inspect] Unknown REPORT '${report}'.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableConnectError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to connect|timeout|econnreset|econnrefused|socket hang up/i.test(message);
}

async function connectWithRetry(pool, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.connect();
      return;
    } catch (error) {
      if (attempt >= attempts || !isRetryableConnectError(error)) {
        throw error;
      }

      const delayMs = attempt * 2000;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[db-inspect] SQL connect attempt ${attempt}/${attempts} failed: ${message}. Retrying in ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }
}

async function run() {
  const pool = new sql.ConnectionPool(databaseUrl);
  const builtInReport = getBuiltInReport(reportName);

  try {
    await connectWithRetry(pool);

    let queryToRun = customSql;
    let reportNote = "";

    if (!queryToRun && builtInReport) {
      const schemaProbe = await pool.request().query(`
        SELECT CASE
          WHEN COL_LENGTH('sessions', 'traffic_source') IS NULL THEN 0
          ELSE 1
        END AS has_traffic_source;
      `);
      const hasTrafficSource = schemaProbe.recordset[0]?.has_traffic_source === 1;
      queryToRun = hasTrafficSource ? builtInReport.sql : builtInReport.legacySql;
      if (!hasTrafficSource) {
        reportNote =
          "[db-inspect] traffic_source column not found; falling back to legacy unfiltered completion stats.";
      }
    }

    if (queryToRun) {
      const result = await pool.request().query(queryToRun);
      printSection(builtInReport?.title ?? "Custom Query Result");
      if (reportNote) {
        console.log(reportNote);
      }
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
          CONCAT(
            LEFT(CONVERT(varchar(36), token), 8),
            '...',
            RIGHT(CONVERT(varchar(36), token), 4)
          ) AS token_hint,
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
    try {
      await pool.close();
    } catch {
      // Ignore close errors during failed connection attempts.
    }
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[db-inspect] ${message}`);
  process.exit(1);
});
