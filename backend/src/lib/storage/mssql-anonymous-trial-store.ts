import type sql from "mssql";
import type { AnonymousTrialClaim, IAnonymousTrialStore } from "./types";

export class MssqlAnonymousTrialStore implements IAnonymousTrialStore {
  constructor(private pool: sql.ConnectionPool) {}

  async hasActiveClaim(claimKey: string, now = Date.now()): Promise<boolean> {
    const result = await this.pool.request()
      .input("claimKey", claimKey)
      .input("nowTs", now)
      .query<{ active_count: number }>(`
        SELECT COUNT(*) AS active_count
        FROM anonymous_trial_claims
        WHERE claim_key = @claimKey
          AND expires_at_ts > @nowTs
      `);

    return Number(result.recordset[0]?.active_count ?? 0) > 0;
  }

  async createOrRefreshClaim(claim: AnonymousTrialClaim): Promise<void> {
    await this.pool.request()
      .input("claimKey", claim.claimKey)
      .input("createdAtTs", claim.createdAt)
      .input("expiresAtTs", claim.expiresAt)
      .query(`
        MERGE anonymous_trial_claims AS target
        USING (SELECT @claimKey AS claim_key) AS source
        ON target.claim_key = source.claim_key
        WHEN MATCHED THEN
          UPDATE SET
            created_at_ts = @createdAtTs,
            expires_at_ts = @expiresAtTs,
            updated_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN
          INSERT (claim_key, created_at_ts, expires_at_ts)
          VALUES (@claimKey, @createdAtTs, @expiresAtTs);
      `);
  }
}
