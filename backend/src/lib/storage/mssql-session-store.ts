import type sql from "mssql";
import type { Difficulty } from "../../../../shared/types/game";
import type { CreateGameSessionInput, ISessionStore, GameSession } from "./types";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class MssqlSessionStore implements ISessionStore {
  constructor(private pool: sql.ConnectionPool) {}

  async create(input: CreateGameSessionInput): Promise<string>;
  async create(difficulty: Difficulty, scenarioTitle: string): Promise<string>;
  async create(
    difficultyOrInput: Difficulty | CreateGameSessionInput,
    scenarioTitle?: string
  ): Promise<string> {
    const token = crypto.randomUUID();
    const startTime = Date.now();
    const input: CreateGameSessionInput =
      typeof difficultyOrInput === "string"
        ? {
            difficulty: difficultyOrInput,
            scenarioTitle: scenarioTitle ?? "Unknown Scenario",
            identityKind: "anonymous",
            anonymousClaimKey: null,
            githubLogin: null,
            githubUserId: null,
            persistentScoreEligible: false,
          }
        : difficultyOrInput;

    await this.pool.request()
      .input("token", token)
      .input("difficulty", input.difficulty)
      .input("scenarioTitle", input.scenarioTitle)
      .input("startTime", startTime)
      .input("identityKind", input.identityKind)
      .input("githubUserId", input.githubUserId ?? null)
      .input("githubLogin", input.githubLogin ?? null)
      .input("anonymousClaimKey", input.anonymousClaimKey ?? null)
      .input("persistentScoreEligible", input.persistentScoreEligible ? 1 : 0)
      .query(`
        INSERT INTO sessions (
          token,
          difficulty,
          scenario_title,
          start_time,
          identity_kind,
          github_user_id,
          github_login,
          anonymous_claim_key,
          persistent_score_eligible
        )
        VALUES (
          @token,
          @difficulty,
          @scenarioTitle,
          @startTime,
          @identityKind,
          @githubUserId,
          @githubLogin,
          @anonymousClaimKey,
          @persistentScoreEligible
        )
      `);

    this.cleanupStale().catch((err) => {
      console.error("[session] failed to cleanup stale sessions", err);
    });

    return token;
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
        identity_kind: "github" | "anonymous";
        github_user_id: string | null;
        github_login: string | null;
        anonymous_claim_key: string | null;
        persistent_score_eligible: boolean;
      }>(`
        UPDATE sessions
        SET used = 1
        OUTPUT
          INSERTED.token,
          INSERTED.difficulty,
          INSERTED.scenario_title,
          INSERTED.start_time,
          INSERTED.used,
          INSERTED.identity_kind,
          INSERTED.github_user_id,
          INSERTED.github_login,
          INSERTED.anonymous_claim_key,
          INSERTED.persistent_score_eligible
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
      identityKind: row.identity_kind,
      githubUserId: row.github_user_id,
      githubLogin: row.github_login,
      anonymousClaimKey: row.anonymous_claim_key,
      persistentScoreEligible: Boolean(row.persistent_score_eligible),
    };
  }

  private async cleanupStale(): Promise<void> {
    await this.pool.request()
      .input("cutoff", Date.now() - SESSION_TTL_MS)
      .query("DELETE FROM sessions WHERE start_time < @cutoff");
  }
}
