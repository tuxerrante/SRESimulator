import {
  ACTOR_REF_HEADER,
  GAME_SESSION_REF_HEADER,
  REQUEST_ID_HEADER,
} from "@shared/telemetry/constants";
import { getOrCreateActorRef } from "./actor-ref";

async function toGameSessionRef(sessionToken: string | null): Promise<string | undefined> {
  if (!sessionToken) {
    return undefined;
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sessionToken),
  );

  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildTelemetryHeaders(sessionToken: string | null): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    [REQUEST_ID_HEADER]: crypto.randomUUID(),
    [ACTOR_REF_HEADER]: getOrCreateActorRef(),
  };

  const gameSessionRef = await toGameSessionRef(sessionToken);
  if (gameSessionRef) {
    headers[GAME_SESSION_REF_HEADER] = gameSessionRef;
  }

  return headers;
}
