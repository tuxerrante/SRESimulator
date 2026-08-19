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
  const ip = input.ip?.trim();
  const ipHash = ip ? hashSignal(ip) : null;

  const fingerprintSignals = [input.fingerprintHash.trim(), userAgentHash];
  if (ipHash) {
    fingerprintSignals.push(ipHash);
  }

  const claimKeys = [buildClaimDigest(fingerprintSignals.join(":"), secret)];
  if (ipHash) {
    claimKeys.push(buildClaimDigest(["ip-ua", ipHash, userAgentHash].join(":"), secret));
    claimKeys.push(buildClaimDigest(["ip", ipHash].join(":"), secret));
  }

  return claimKeys;
}
