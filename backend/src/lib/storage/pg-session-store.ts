import type { Pool } from "pg";
import type { Difficulty } from "../../../../shared/types/game";
import type { ISessionStore, GameSession } from "./types";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class PgSessionStore implements ISessionStore {
  constructor(private pool: Pool) {}

  async create(difficulty: Difficulty, scenarioTitle: string): Promise<string> {
    const token = crypto.randomUUID();
    const startTime = Date.now();

    await this.pool.query(
      `INSERT INTO sessions (token, difficulty, scenario_title, start_time)
       VALUES ($1, $2, $3, $4)`,
      [token, difficulty, scenarioTitle, startTime]
    );

    this.cleanupStale().catch(() => {});

    return token;
  }

  async validateAndConsume(token: string): Promise<GameSession | null> {
    const { rows } = await this.pool.query<{
      token: string;
      difficulty: Difficulty;
      scenario_title: string;
      start_time: string;
      used: boolean;
    }>(
      `UPDATE sessions
       SET used = TRUE
       WHERE token = $1
         AND used = FALSE
         AND start_time > $2
       RETURNING token, difficulty, scenario_title, start_time, used`,
      [token, Date.now() - SESSION_TTL_MS]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      token: row.token,
      difficulty: row.difficulty,
      scenarioTitle: row.scenario_title,
      startTime: Number(row.start_time),
      used: true,
    };
  }

  private async cleanupStale(): Promise<void> {
    await this.pool.query(
      "DELETE FROM sessions WHERE start_time < $1",
      [Date.now() - SESSION_TTL_MS]
    );
  }
}
