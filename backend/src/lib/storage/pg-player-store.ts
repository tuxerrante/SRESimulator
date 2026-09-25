import type { GithubViewer } from "../../../../shared/auth/viewer";
import { pgQuery, pgReadQuery, type PgQueryable } from "./pg-pool";
import type { IPlayerStore, PlayerRecord } from "./types";

export class PgPlayerStore implements IPlayerStore {
  constructor(private pool: PgQueryable) {}

  async upsertGithubViewer(viewer: GithubViewer): Promise<PlayerRecord> {
    await pgQuery(this.pool, `
      INSERT INTO players (github_user_id, github_login, display_name, avatar_url)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (github_user_id) DO UPDATE SET
        github_login = EXCLUDED.github_login,
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = now()
    `, [
      viewer.githubUserId,
      viewer.githubLogin,
      viewer.displayName,
      viewer.avatarUrl,
    ]);

    return {
      githubUserId: viewer.githubUserId,
      githubLogin: viewer.githubLogin,
      displayName: viewer.displayName,
      avatarUrl: viewer.avatarUrl,
    };
  }

  async getByGithubUserId(githubUserId: string): Promise<PlayerRecord | null> {
    const result = await pgReadQuery<{
      github_user_id: string;
      github_login: string;
      display_name: string;
      avatar_url: string | null;
      created_at: Date;
      updated_at: Date;
    }>(this.pool, `
      SELECT github_user_id, github_login, display_name, avatar_url, created_at, updated_at
      FROM players
      WHERE github_user_id = $1
    `, [githubUserId]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      githubUserId: row.github_user_id,
      githubLogin: row.github_login,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
