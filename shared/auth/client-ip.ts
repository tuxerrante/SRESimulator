import { createHmac, timingSafeEqual } from "node:crypto";

function signValue(value: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(value.trim()).digest();
}

export function createSignedClientIp(ip: string, secret: string): string {
  return signValue(ip, secret).toString("base64url");
}

export function verifySignedClientIp(
  ip: string,
  signature: string,
  secret: string
): boolean {
  const expected = signValue(ip, secret);
  const actual = Buffer.from(signature, "base64url");

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
