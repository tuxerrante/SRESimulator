import { pgQuery, pgReadQuery, type PgQueryable } from "./pg-pool";
import type { AnonymousTrialClaim, IAnonymousTrialStore } from "./types";

/**
 * The subset of `pg.Pool` this store needs: plain queries plus a checked-out
 * client, because `reserveClaimKeys` is all-or-nothing and therefore needs a
 * real transaction rather than a single autocommitted statement.
 */
export interface PgTransactional extends PgQueryable {
  connect(): Promise<PgTransactionalClient>;
}

export interface PgTransactionalClient extends PgQueryable {
  release(): void;
}

export class PgAnonymousTrialStore implements IAnonymousTrialStore {
  constructor(private pool: PgTransactional) {}

  async hasActiveClaim(claimKey: string, now: number = Date.now()): Promise<boolean> {
    const result = await pgReadQuery<{ one: number }>(this.pool, `
      SELECT 1 AS one
      FROM anonymous_trial_claims
      WHERE claim_key = $1
        AND expires_at_ts > $2
      LIMIT 1
    `, [claimKey, now]);

    return result.rows.length > 0;
  }

  async createOrRefreshClaim(claim: AnonymousTrialClaim): Promise<void> {
    await pgQuery(this.pool, `
      INSERT INTO anonymous_trial_claims (claim_key, created_at_ts, expires_at_ts)
      VALUES ($1, $2, $3)
      ON CONFLICT (claim_key) DO UPDATE SET
        created_at_ts = EXCLUDED.created_at_ts,
        expires_at_ts = EXCLUDED.expires_at_ts,
        updated_at = now()
    `, [claim.claimKey, claim.createdAt, claim.expiresAt]);
  }

  /**
   * Reserve every key or none.
   *
   * The MSSQL original takes SERIALIZABLE plus `WITH (UPDLOCK, HOLDLOCK)` on
   * rows that usually do not exist yet. The direct Postgres translation --
   * `SELECT ... FOR UPDATE` followed by an insert -- would lock nothing in that
   * case, so two concurrent callers would both see the key free and both claim
   * it. That is an anti-abuse hole, not a performance detail.
   *
   * Instead the check and the write are one statement. `ON CONFLICT DO UPDATE`
   * takes a row lock and re-evaluates its `WHERE` against the *latest* row
   * version, so a caller racing an already-committed live claim sees
   * `expires_at_ts > now`, updates nothing, and gets no row back. The row count
   * is therefore an honest answer to "did I win every key".
   *
   * The transaction exists for the partial case: when one key is live and the
   * rest are free, the free ones must not stay claimed by a caller who is about
   * to be told no.
   */
  async reserveClaimKeys(claimKeys: string[], claim: AnonymousTrialClaim): Promise<boolean> {
    if (claimKeys.length === 0) {
      return true;
    }

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query<{ claim_key: string }>(`
        INSERT INTO anonymous_trial_claims (claim_key, created_at_ts, expires_at_ts)
        SELECT k, $2::bigint, $3::bigint
        FROM unnest($1::text[]) AS k
        ON CONFLICT (claim_key) DO UPDATE SET
          created_at_ts = EXCLUDED.created_at_ts,
          expires_at_ts = EXCLUDED.expires_at_ts,
          updated_at = now()
        WHERE anonymous_trial_claims.expires_at_ts <= $2::bigint
        RETURNING claim_key
      `, [claimKeys, claim.createdAt, claim.expiresAt]);

      if (result.rows.length !== claimKeys.length) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => { /* the transaction is already lost */ });
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseClaimKeys(claimKeys: string[]): Promise<void> {
    if (claimKeys.length === 0) {
      return;
    }

    await pgQuery(
      this.pool,
      "DELETE FROM anonymous_trial_claims WHERE claim_key = ANY($1::text[])",
      [claimKeys],
    );
  }
}
