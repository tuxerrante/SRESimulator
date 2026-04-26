import type sql from "mssql";
import type { GithubViewer } from "../../../../shared/auth/viewer";
import type { IPlayerStore, PlayerRecord } from "./types";

export class MssqlPlayerStore implements IPlayerStore {
  constructor(private pool: sql.ConnectionPool) {}

  async upsertGithubViewer(viewer: GithubViewer): Promise<PlayerRecord> {
    await this.pool.request()
      .input("githubUserId", viewer.githubUserId)
      .input("githubLogin", viewer.githubLogin)
      .input("displayName", viewer.displayName)
      .input("avatarUrl", viewer.avatarUrl)
      .query(`
        MERGE players AS target
        USING (SELECT @githubUserId AS github_user_id) AS source
        ON target.github_user_id = source.github_user_id
        WHEN MATCHED THEN
          UPDATE SET
            github_login = @githubLogin,
            display_name = @displayName,
            avatar_url = @avatarUrl,
            updated_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN
          INSERT (github_user_id, github_login, display_name, avatar_url)
          VALUES (@githubUserId, @githubLogin, @displayName, @avatarUrl);
      `);

    return {
      githubUserId: viewer.githubUserId,
      githubLogin: viewer.githubLogin,
      displayName: viewer.displayName,
      avatarUrl: viewer.avatarUrl,
    };
  }

  async getByGithubUserId(githubUserId: string): Promise<PlayerRecord | null> {
    const result = await this.pool.request()
      .input("githubUserId", githubUserId)
      .query<{
        github_user_id: string;
        github_login: string;
        display_name: string;
        avatar_url: string | null;
        created_at: Date;
        updated_at: Date;
      }>(`
        SELECT github_user_id, github_login, display_name, avatar_url, created_at, updated_at
        FROM players
        WHERE github_user_id = @githubUserId
      `);

    const row = result.recordset[0];
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
