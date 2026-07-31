import type sql from "mssql";
import type { Difficulty } from "../../../../shared/types/game";
import { DEFAULT_PLATFORM_ID } from "../../../../shared/types/platform";
import type { CreateGameSessionInput, ISessionStore, GameSession, TrafficSource } from "./types";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class MssqlSessionStore implements ISessionStore {
  constructor(private pool: sql.ConnectionPool) {}

  async create(input: CreateGameSessionInput): Promise<string>;
  async create(difficulty: Difficulty, scenarioTitle: string): Promise<string>;
  async create(difficulty: Difficulty, scenarioTitle: string, trafficSource: TrafficSource): Promise<string>;
  async create(
    difficultyOrInput: Difficulty | CreateGameSessionInput,
    scenarioTitle?: string,
    trafficSource: TrafficSource = "player",
  ): Promise<string> {
    const token = crypto.randomUUID();
    const startTime = Date.now();
    const input: CreateGameSessionInput =
      typeof difficultyOrInput === "string"
        ? {
            platform: DEFAULT_PLATFORM_ID,
            difficulty: difficultyOrInput,
            scenarioTitle: scenarioTitle ?? "Unknown Scenario",
            trafficSource,
            identityKind: "anonymous",
            anonymousClaimKey: null,
            githubLogin: null,
            githubUserId: null,
            persistentScoreEligible: false,
          }
        : difficultyOrInput;

    await this.pool.request()
      .input("token", token)
      .input("platform", input.platform)
      .input("difficulty", input.difficulty)
      .input("scenarioId", input.scenarioId ?? null)
      .input("scenarioTitle", input.scenarioTitle)
      .input("scenarioPayload", input.scenarioPayload ?? null)
      .input("startTime", startTime)
      .input("trafficSource", input.trafficSource ?? "player")
      .input("identityKind", input.identityKind)
      .input("githubUserId", input.githubUserId ?? null)
      .input("githubLogin", input.githubLogin ?? null)
      .input("anonymousClaimKey", input.anonymousClaimKey ?? null)
      .input("persistentScoreEligible", input.persistentScoreEligible ? 1 : 0)
      .query(`
        INSERT INTO sessions (
          token,
          platform,
          difficulty,
          scenario_id,
          scenario_title,
          scenario_payload,
          start_time,
          traffic_source,
          identity_kind,
          github_user_id,
          github_login,
          anonymous_claim_key,
          persistent_score_eligible
        )
        VALUES (
          @token,
          @platform,
          @difficulty,
          @scenarioId,
          @scenarioTitle,
          @scenarioPayload,
          @startTime,
          @trafficSource,
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

  async get(token: string): Promise<GameSession | null> {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(token)) return null;

    const cutoff = Date.now() - SESSION_TTL_MS;

    const result = await this.pool.request()
      .input("token", token)
      .input("cutoff", cutoff)
      .query<{
        token: string;
        platform: "aro-classic" | "aro-hcp" | "aks";
        difficulty: Difficulty;
        scenario_id: string | null;
        scenario_title: string;
        scenario_payload: string | null;
        start_time: number;
        used: boolean;
        traffic_source: "player" | "automated";
        identity_kind: "github" | "anonymous";
        github_user_id: string | null;
        github_login: string | null;
        anonymous_claim_key: string | null;
        persistent_score_eligible: boolean;
      }>(`
        SELECT
          token,
          platform,
          difficulty,
          scenario_id,
          scenario_title,
          scenario_payload,
          start_time,
          used,
          traffic_source,
          identity_kind,
          github_user_id,
          github_login,
          anonymous_claim_key,
          persistent_score_eligible
        FROM sessions
        WHERE token = @token
          AND start_time > @cutoff
      `);

    if (result.recordset.length === 0) return null;

    const row = result.recordset[0];
    return {
      token: row.token,
      platform: row.platform,
      difficulty: row.difficulty,
      scenarioId: row.scenario_id,
      scenarioTitle: row.scenario_title,
      scenarioPayload: row.scenario_payload,
      startTime: Number(row.start_time),
      used: row.used,
      trafficSource: row.traffic_source,
      identityKind: row.identity_kind,
      githubUserId: row.github_user_id,
      githubLogin: row.github_login,
      anonymousClaimKey: row.anonymous_claim_key,
      persistentScoreEligible: Boolean(row.persistent_score_eligible),
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
        platform: "aro-classic" | "aro-hcp" | "aks";
        difficulty: Difficulty;
        scenario_id: string | null;
        scenario_title: string;
        scenario_payload: string | null;
        start_time: number;
        used: boolean;
        traffic_source: "player" | "automated";
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
          INSERTED.platform,
          INSERTED.difficulty,
          INSERTED.scenario_id,
          INSERTED.scenario_title,
          INSERTED.scenario_payload,
          INSERTED.start_time,
          INSERTED.used,
          INSERTED.traffic_source,
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
      platform: row.platform,
      difficulty: row.difficulty,
      scenarioId: row.scenario_id,
      scenarioTitle: row.scenario_title,
      scenarioPayload: row.scenario_payload,
      startTime: Number(row.start_time),
      used: true,
      trafficSource: row.traffic_source,
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
