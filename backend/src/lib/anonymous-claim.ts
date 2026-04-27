import { createHash, createHmac } from "node:crypto";

interface AnonymousClaimKeyInput {
  fingerprintHash: string;
  ip?: string | null;
  userAgent: string;
}

function hashSignal(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildClaimDigest(normalizedSignals: string, secret: string): string {
  return createHmac("sha256", secret).update(normalizedSignals).digest("hex");
}

export function buildAnonymousClaimKeys(
  input: AnonymousClaimKeyInput,
  secret: string
): string[] {
  const userAgentHash = hashSignal(input.userAgent.trim());
  const fingerprintSignals = [input.fingerprintHash.trim(), userAgentHash];
  const ip = input.ip?.trim();
  if (ip) {
    const ipHash = hashSignal(ip);
    fingerprintSignals.push(ipHash);
  }

  const fingerprintKey = fingerprintSignals.join(":");

  const claimKeys = [buildClaimDigest(fingerprintKey, secret)];
  if (ip) {
    const ipHash = hashSignal(ip);
    claimKeys.push(buildClaimDigest(["ip-ua", ipHash, userAgentHash].join(":"), secret));
  }

  return claimKeys;
}
