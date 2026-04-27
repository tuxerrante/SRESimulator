import type sql from "mssql";
import type { Difficulty } from "../../../../shared/types/game";
import type { ISessionStore, GameSession } from "./types";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class MssqlSessionStore implements ISessionStore {
  constructor(private pool: sql.ConnectionPool) {}

  async create(difficulty: Difficulty, scenarioTitle: string): Promise<string> {
    const token = crypto.randomUUID();
    const startTime = Date.now();

    await this.pool.request()
      .input("token", token)
      .input("difficulty", difficulty)
      .input("scenarioTitle", scenarioTitle)
      .input("startTime", startTime)
      .query(`
        INSERT INTO sessions (token, difficulty, scenario_title, start_time)
        VALUES (@token, @difficulty, @scenarioTitle, @startTime)
      `);

    this.cleanupStale().catch((err) => {
      console.error("[session] failed to cleanup stale sessions", err);
    });

    return token;
  }

  async get(token: string): Promise<GameSession | null> {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(token)) return null;

    const cutoff = Date.now() - SESSION_TTL_MS;

    const result = await this.pool.request()
      .input("token", token)
      .input("cutoff", cutoff)
      .query<{
        token: string;
        difficulty: Difficulty;
        scenario_title: string;
        start_time: number;
        used: boolean;
      }>(`
        SELECT token, difficulty, scenario_title, start_time, used
        FROM sessions
        WHERE token = @token
          AND start_time > @cutoff
      `);

    if (result.recordset.length === 0) return null;

    const row = result.recordset[0];
    return {
      token: row.token,
      difficulty: row.difficulty,
      scenarioTitle: row.scenario_title,
      startTime: Number(row.start_time),
      used: row.used,
    };
  }

  async validateAndConsume(token: string): Promise<GameSession | null> {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(token)) return null;

    const cutoff = Date.now() - SESSION_TTL_MS;

    const result = await this.pool.request()
      .input("token", token)
      .input("cutoff", cutoff)
      .query<{
        token: string;
        difficulty: Difficulty;
        scenario_title: string;
        start_time: number;
        used: boolean;
      }>(`
        UPDATE sessions
        SET used = 1
        OUTPUT
          INSERTED.token,
          INSERTED.difficulty,
          INSERTED.scenario_title,
          INSERTED.start_time,
          INSERTED.used
        WHERE token = @token
          AND used = 0
          AND start_time > @cutoff
      `);

    if (result.recordset.length === 0) return null;

    const row = result.recordset[0];
    return {
      token: row.token,
      difficulty: row.difficulty,
      scenarioTitle: row.scenario_title,
      startTime: Number(row.start_time),
      used: true,
    };
  }

  private async cleanupStale(): Promise<void> {
    await this.pool.request()
      .input("cutoff", Date.now() - SESSION_TTL_MS)
      .query("DELETE FROM sessions WHERE start_time < @cutoff");
  }
}
