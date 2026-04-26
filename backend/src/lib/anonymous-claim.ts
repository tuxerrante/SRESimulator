import { createHash, createHmac } from "node:crypto";

interface AnonymousClaimKeyInput {
  fingerprintHash: string;
  ip: string;
  userAgent: string;
}

function hashSignal(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildAnonymousClaimKey(
  input: AnonymousClaimKeyInput,
  secret: string
): string {
  const normalizedSignals = [
    input.fingerprintHash.trim(),
    hashSignal(input.ip.trim()),
    hashSignal(input.userAgent.trim()),
  ].join(":");

  return createHmac("sha256", secret).update(normalizedSignals).digest("hex");
}
