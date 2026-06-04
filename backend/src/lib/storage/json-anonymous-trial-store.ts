import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { AnonymousTrialClaim, IAnonymousTrialStore } from "./types";

export class JsonAnonymousTrialStore implements IAnonymousTrialStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor() {
    this.dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.filePath = path.join(this.dataDir, "anonymous-trial-claims.json");
  }

  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeLock.then(fn, fn);
    this.writeLock = next.then(() => {}, () => {});
    return next;
  }

  private async ensureFile(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
    if (!existsSync(this.filePath)) {
      await writeFile(this.filePath, "[]", "utf-8");
    }
  }

  private async readClaims(): Promise<AnonymousTrialClaim[]> {
    await this.ensureFile();
    const data = await readFile(this.filePath, "utf-8");
    return JSON.parse(data) as AnonymousTrialClaim[];
  }

  private async writeClaims(claims: AnonymousTrialClaim[]): Promise<void> {
    await this.ensureFile();
    const tmpFile = `${this.filePath}.tmp`;
    await writeFile(tmpFile, JSON.stringify(claims, null, 2), "utf-8");
    await rename(tmpFile, this.filePath);
  }

  private removeExpired(claims: AnonymousTrialClaim[], now: number): AnonymousTrialClaim[] {
    return claims.filter((claim) => claim.expiresAt > now);
  }

  async hasActiveClaim(claimKey: string, now = Date.now()): Promise<boolean> {
    const claims = this.removeExpired(await this.readClaims(), now);
    return claims.some((claim) => claim.claimKey === claimKey);
  }

  async createOrRefreshClaim(claim: AnonymousTrialClaim): Promise<void> {
    await this.withWriteLock(async () => {
      const claims = this.removeExpired(await this.readClaims(), claim.createdAt);
      const withoutCurrent = claims.filter((item) => item.claimKey !== claim.claimKey);
      withoutCurrent.push(claim);
      await this.writeClaims(withoutCurrent);
    });
  }

  async reserveClaimKeys(claimKeys: string[], claim: AnonymousTrialClaim): Promise<boolean> {
    return this.withWriteLock(async () => {
      const claims = this.removeExpired(await this.readClaims(), claim.createdAt);
      if (claimKeys.some((claimKey) => claims.some((item) => item.claimKey === claimKey))) {
        return false;
      }

      claims.push(
        ...claimKeys.map((claimKey) => ({
          claimKey,
          createdAt: claim.createdAt,
          expiresAt: claim.expiresAt,
        }))
      );
      await this.writeClaims(claims);
      return true;
    });
  }

  async releaseClaimKeys(claimKeys: string[]): Promise<void> {
    await this.withWriteLock(async () => {
      const claims = await this.readClaims();
      await this.writeClaims(claims.filter((claim) => !claimKeys.includes(claim.claimKey)));
    });
  }
}
