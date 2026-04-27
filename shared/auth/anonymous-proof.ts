import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface AnonymousProofSession {
  fingerprintHash: string;
  userAgentHash: string;
  issuedAt: number;
  expiresAt: number;
}

interface ReadAnonymousProofOptions {
  now?: number;
  userAgent?: string;
}

function encodePayload(session: AnonymousProofSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function decodePayload(token: string): AnonymousProofSession | null {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as AnonymousProofSession;
  } catch {
    return null;
  }
}

function isAnonymousProofSession(value: unknown): value is AnonymousProofSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const session = value as Record<string, unknown>;
  return (
    typeof session.fingerprintHash === "string" &&
    session.fingerprintHash.trim().length > 0 &&
    typeof session.userAgentHash === "string" &&
    session.userAgentHash.trim().length > 0 &&
    Number.isFinite(session.issuedAt) &&
    Number.isFinite(session.expiresAt)
  );
}

function signPayload(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function hashAnonymousProofUserAgent(userAgent: string): string {
  return createHash("sha256").update(userAgent.trim()).digest("hex");
}

export function createAnonymousProofToken(
  session: AnonymousProofSession,
  secret: string
): string {
  const payload = encodePayload(session);
  const signature = signPayload(payload, secret).toString("base64url");
  return `${payload}.${signature}`;
}

export function readAnonymousProofToken(
  token: string,
  secret: string,
  options: ReadAnonymousProofOptions = {}
): AnonymousProofSession | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = signPayload(payload, secret);
  const actualSignature = Buffer.from(signature, "base64url");

  if (
    expectedSignature.length !== actualSignature.length ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return null;
  }

  const session = decodePayload(payload);
  if (!isAnonymousProofSession(session)) {
    return null;
  }

  const now = options.now ?? Date.now();
  if (session.expiresAt <= now) {
    return null;
  }

  if (
    options.userAgent &&
    session.userAgentHash !== hashAnonymousProofUserAgent(options.userAgent)
  ) {
    return null;
  }

  return session;
}
