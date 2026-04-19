import type { Server } from "http";
import type { Express } from "express";

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
  messages: ChatMessage[];
  scenario: unknown | null;
  currentPhase: string;
}

export function getAutomatedTrafficHeaders(): Record<string, string> {
  const token = process.env.AUTOMATED_TRAFFIC_TOKEN?.trim() ?? "";
  if (!token) return {};

  return {
    "x-traffic-source": "automated",
    "x-traffic-source-token": token,
  };
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
): ChatRequestBody {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Turn ${i}: ${"x".repeat(200)}`,
    });
  }
  return { messages, scenario: null, currentPhase: phase };
}
