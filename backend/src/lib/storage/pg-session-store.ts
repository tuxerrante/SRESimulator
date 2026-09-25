import type { Difficulty } from "../../../../shared/types/game";
import { DEFAULT_PLATFORM_ID } from "../../../../shared/types/platform";
import { pgQuery, pgReadQuery, type PgQueryable } from "./pg-pool";
import type { CreateGameSessionInput, ISessionStore, GameSession, TrafficSource } from "./types";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SessionRow {
  token: string;
  platform: "aro-classic" | "aro-hcp" | "aks";
  difficulty: Difficulty;
  scenario_id: string | null;
  scenario_title: string;
  scenario_payload: string | null;
  start_time: string | number;
  used: boolean;
  traffic_source: "player" | "automated";
  identity_kind: "github" | "anonymous";
  github_user_id: string | null;
  github_login: string | null;
  anonymous_claim_key: string | null;
  persistent_score_eligible: boolean;
}

const SESSION_COLUMNS = `
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
`;

function mapSessionRow(row: SessionRow): GameSession {
  return {
    token: row.token,
    platform: row.platform,
    difficulty: row.difficulty,
    scenarioId: row.scenario_id,
    scenarioTitle: row.scenario_title,
    scenarioPayload: row.scenario_payload,
    // BIGINT arrives as a string from `pg`; the MSSQL store needs the same
    // coercion, so the mapped shape is identical across backends.
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

export class PgSessionStore implements ISessionStore {
  constructor(private pool: PgQueryable) {}

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

    await pgQuery(this.pool, `
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      token,
      input.platform,
      input.difficulty,
      input.scenarioId ?? null,
      input.scenarioTitle,
      input.scenarioPayload ?? null,
      startTime,
      input.trafficSource ?? "player",
      input.identityKind,
      input.githubUserId ?? null,
      input.githubLogin ?? null,
      input.anonymousClaimKey ?? null,
      input.persistentScoreEligible,
    ]);

    this.cleanupStale().catch((err) => {
      console.error("[session] failed to cleanup stale sessions", err);
    });

    return token;
  }

  async get(token: string): Promise<GameSession | null> {
    // Postgres rejects a malformed UUID with 22P02 rather than returning no
    // rows, so the shape check has to happen before the query, exactly as on
    // MSSQL.
    if (!UUID_RE.test(token)) return null;

    const cutoff = Date.now() - SESSION_TTL_MS;

    const result = await pgReadQuery<SessionRow>(this.pool, `
      SELECT ${SESSION_COLUMNS}
      FROM sessions
      WHERE token = $1
        AND start_time > $2
    `, [token, cutoff]);

    const row = result.rows[0];
    if (!row) return null;

    return mapSessionRow(row);
  }

  async validateAndConsume(token: string): Promise<GameSession | null> {
    if (!UUID_RE.test(token)) return null;

    const cutoff = Date.now() - SESSION_TTL_MS;

    const result = await pgQuery<SessionRow>(this.pool, `
      UPDATE sessions
      SET used = TRUE
      WHERE token = $1
        AND used = FALSE
        AND start_time > $2
      RETURNING ${SESSION_COLUMNS}
    `, [token, cutoff]);

    const row = result.rows[0];
    if (!row) return null;

    return { ...mapSessionRow(row), used: true };
  }

  private async cleanupStale(): Promise<void> {
    await pgQuery(
      this.pool,
      "DELETE FROM sessions WHERE start_time < $1",
      [Date.now() - SESSION_TTL_MS],
    );
  }
}
