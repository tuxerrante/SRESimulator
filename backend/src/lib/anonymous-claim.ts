import { createHash, createHmac } from "node:crypto";

interface AnonymousClaimKeyInput {
  fingerprintHash: string;
  ip: string;
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
  const ipHash = hashSignal(input.ip.trim());
  const fingerprintKey = [
    input.fingerprintHash.trim(),
    ipHash,
    userAgentHash,
  ].join(":");
  const fallbackKey = ["ip-ua", ipHash, userAgentHash].join(":");

  return [
    buildClaimDigest(fingerprintKey, secret),
    buildClaimDigest(fallbackKey, secret),
  ];
}
