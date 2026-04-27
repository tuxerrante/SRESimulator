import sql from "mssql";
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

  async reserveClaimKeys(claimKeys: string[], claim: AnonymousTrialClaim): Promise<boolean> {
    if (claimKeys.length === 0) {
      return true;
    }

    const transaction = new sql.Transaction(this.pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    try {
      const placeholders = claimKeys.map((_, index) => `@claimKey${index}`).join(", ");
      const lockRequest = new sql.Request(transaction).input("nowTs", claim.createdAt);
      for (const [index, claimKey] of claimKeys.entries()) {
        lockRequest.input(`claimKey${index}`, claimKey);
      }

      const existingClaims = await lockRequest.query<{ claim_key: string; expires_at_ts: number }>(`
        SELECT claim_key, expires_at_ts
        FROM anonymous_trial_claims
        WITH (UPDLOCK, HOLDLOCK)
        WHERE claim_key IN (${placeholders})
      `);

      if (
        existingClaims.recordset.some((existingClaim) => existingClaim.expires_at_ts > claim.createdAt)
      ) {
        await transaction.rollback();
        return false;
      }

      const deleteRequest = new sql.Request(transaction);
      for (const [index, claimKey] of claimKeys.entries()) {
        deleteRequest.input(`claimKey${index}`, claimKey);
      }
      await deleteRequest.query(`
        DELETE FROM anonymous_trial_claims
        WHERE claim_key IN (${placeholders})
      `);

      const insertRequest = new sql.Request(transaction)
        .input("createdAtTs", claim.createdAt)
        .input("expiresAtTs", claim.expiresAt);
      const values = claimKeys.map((_, index) => `(@claimKey${index}, @createdAtTs, @expiresAtTs)`).join(", ");
      for (const [index, claimKey] of claimKeys.entries()) {
        insertRequest.input(`claimKey${index}`, claimKey);
      }
      await insertRequest.query(`
        INSERT INTO anonymous_trial_claims (claim_key, created_at_ts, expires_at_ts)
        VALUES ${values}
      `);

      await transaction.commit();
      return true;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // Ignore rollback failures when the transaction is already closed.
      }
      throw error;
    }
  }

  async releaseClaimKeys(claimKeys: string[]): Promise<void> {
    if (claimKeys.length === 0) {
      return;
    }

    const request = this.pool.request();
    const placeholders = claimKeys.map((_, index) => `@claimKey${index}`).join(", ");
    for (const [index, claimKey] of claimKeys.entries()) {
      request.input(`claimKey${index}`, claimKey);
    }

    await request.query(`
      DELETE FROM anonymous_trial_claims
      WHERE claim_key IN (${placeholders})
    `);
  }
}
