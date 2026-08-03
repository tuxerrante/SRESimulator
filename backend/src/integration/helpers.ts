import type { Server } from "http";
import type { Express } from "express";
import { VIEWER_SESSION_COOKIE } from "../../../shared/auth/constants";
import { createViewerSessionToken } from "../../../shared/auth/session";
import type { Difficulty, Scenario } from "../../../shared/types/game";
import type { PlatformId } from "../../../shared/types/platform";

export interface SSEResult {
  status: number;
  chunks: string[];
  done: boolean;
  rawBody: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequestBody {
  sessionToken: string;
  messages: ChatMessage[];
  scenario: unknown | null;
  currentPhase: string;
}

export interface ScenarioResponse {
  scenario: Scenario;
  sessionToken: string;
}

export function getAutomatedTrafficHeaders(): Record<string, string> {
  const token = process.env.AUTOMATED_TRAFFIC_TOKEN?.trim() ?? "";
  if (!token) return {};

  return {
    "x-traffic-source": "automated",
    "x-traffic-source-token": token,
  };
}

export function getScenarioRequestHeaders(): Record<string, string> {
  if (isExternalTarget()) {
    return {};
  }

  return getAutomatedTrafficHeaders();
}

export function getExpectedScenarioTrafficSource(): "player" | "automated" {
  if (isExternalTarget()) {
    return "player";
  }

  return process.env.AUTOMATED_TRAFFIC_TOKEN?.trim() ? "automated" : "player";
}

export function getViewerAuthCookie(): string | undefined {
  const secret = (
    process.env.E2E_AUTH_SESSION_SECRET ??
    process.env.AUTH_SESSION_SECRET ??
    ""
  ).trim();
  if (!secret) {
    return undefined;
  }

  return `${VIEWER_SESSION_COOKIE}=${createViewerSessionToken(
    {
      kind: "github",
      githubUserId: "e2e-platform-user",
      githubLogin: "e2e-platform-user",
      displayName: "E2E Platform User",
      avatarUrl: null,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000,
    },
    secret,
  )}`;
}

export function getGameplayAdminHeaders(): Record<string, string> {
  const token = (
    process.env.E2E_GAMEPLAY_ADMIN_TOKEN ??
    process.env.GAMEPLAY_ADMIN_TOKEN ??
    ""
  ).trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Return the external backend URL from E2E_BACKEND_URL.
 * When unset, returns "" — the test setup in each suite handles
 * spinning up a local server via `startLocalServer()` instead.
 */
export function getBackendUrl(): string {
  return process.env.E2E_BACKEND_URL ?? "";
}

export function isExternalTarget(): boolean {
  return !!process.env.E2E_BACKEND_URL;
}

/**
 * Start a local Express app on a random port and return its URL + server handle.
 */
export async function startLocalServer(
  app: Express,
): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Bad server address"));
        return;
      }
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

/**
 * POST to a chat SSE endpoint and collect all chunks until [DONE].
 * Works against both local and remote backends.
 */
export async function postChatSSE(
  baseUrl: string,
  body: ChatRequestBody,
): Promise<SSEResult> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const rawBody = await response.text();
  const chunks: string[] = [];
  let done = false;

  for (const line of rawBody.split("\n")) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        done = true;
      } else {
        chunks.push(payload);
      }
    }
  }

  return { status: response.status, chunks, done, rawBody };
}

export async function createScenarioSession(
  baseUrl: string,
  platform: PlatformId,
  difficulty: Difficulty,
): Promise<ScenarioResponse> {
  const cookie = getViewerAuthCookie();
  const response = await fetch(`${baseUrl}/api/scenario`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getScenarioRequestHeaders(),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ platform, difficulty }),
  });

  if (!response.ok) {
    throw new Error(`Scenario bootstrap failed (${response.status})`);
  }

  return (await response.json()) as ScenarioResponse;
}

export async function ensureExternalSessionTokens(
  baseUrl: string,
  count: number,
): Promise<string[]> {
  const sessions = await Promise.all(
    Array.from({ length: count }, () =>
      createScenarioSession(baseUrl, "aro-classic", "easy"),
    ),
  );

  return sessions.map((session) => session.sessionToken);
}

/**
 * Fire N concurrent chat requests and collect all results.
 */
export async function fireParallelChats(
  baseUrl: string,
  bodies: ChatRequestBody[],
): Promise<SSEResult[]> {
  const promises = bodies.map((b) => postChatSSE(baseUrl, b));
  return Promise.all(promises);
}

/**
 * Fetch token metrics from the backend.
 * Passes AI_LIVE_PROBE_TOKEN if set (required in production).
 */
export async function getTokenMetrics(
  baseUrl: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  const probeToken = process.env.AI_LIVE_PROBE_TOKEN;
  if (probeToken) {
    headers["x-ai-probe-token"] = probeToken;
  }

  const response = await fetch(`${baseUrl}/api/ai/token-metrics`, { headers });
  const text = await response.text();
  let body: unknown = text;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
  }

  return { status: response.status, body };
}

/**
 * Build a chat body with a realistic message history of given length.
 */
export function buildChatBody(
  messageCount: number,
  phase: string = "reading",
  sessionToken: string = "session-token",
): ChatRequestBody {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Turn ${i}: ${"x".repeat(200)}`,
    });
  }
  return { sessionToken, messages, scenario: null, currentPhase: phase };
}
