import { createHmac, timingSafeEqual } from "node:crypto";
import type { GithubViewer } from "./viewer";

export interface GithubViewerSession extends GithubViewer {
  issuedAt: number;
  expiresAt: number;
}

export type ViewerSession = GithubViewerSession;

interface ReadViewerSessionOptions {
  now?: number;
}

function encodePayload(session: ViewerSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function decodePayload(token: string): ViewerSession | null {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as ViewerSession;
  } catch {
    return null;
  }
}

function isViewerSession(value: unknown): value is ViewerSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const session = value as Record<string, unknown>;
  return (
    session.kind === "github" &&
    typeof session.githubUserId === "string" &&
    session.githubUserId.trim().length > 0 &&
    typeof session.githubLogin === "string" &&
    session.githubLogin.trim().length > 0 &&
    typeof session.displayName === "string" &&
    session.displayName.trim().length > 0 &&
    (typeof session.avatarUrl === "string" || session.avatarUrl === null) &&
    Number.isFinite(session.issuedAt) &&
    Number.isFinite(session.expiresAt)
  );
}

function signPayload(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function createViewerSessionToken(session: ViewerSession, secret: string): string {
  const payload = encodePayload(session);
  const signature = signPayload(payload, secret).toString("base64url");
  return `${payload}.${signature}`;
}

export function readViewerSessionToken(
  token: string,
  secret: string,
  options: ReadViewerSessionOptions = {}
): ViewerSession | null {
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
  if (!isViewerSession(session)) {
    return null;
  }

  const now = options.now ?? Date.now();
  if (session.expiresAt <= now) {
    return null;
  }

  return session;
}
