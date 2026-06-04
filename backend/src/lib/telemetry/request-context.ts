import type { Request } from "express";
import {
  ACTOR_REF_HEADER,
  GAME_SESSION_REF_HEADER,
  REQUEST_ID_HEADER,
} from "../../../../shared/telemetry/constants";

const UUID_LENGTH = 36;
const GAME_SESSION_REF_LENGTH = 16;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GAME_SESSION_REF_PATTERN = /^[0-9a-f]{16}$/;

function readValidatedHeader(
  req: Request,
  headerName: string,
  maxLength: number,
  pattern: RegExp,
): string | undefined {
  const value = req.get(headerName)?.trim();
  if (!value || value.length > maxLength) {
    return undefined;
  }

  return pattern.test(value) ? value : undefined;
}

export function buildSentryRequestContext(req: Request): {
  tags: Record<string, string>;
  extra: Record<string, unknown>;
} {
  const requestId = readValidatedHeader(req, REQUEST_ID_HEADER, UUID_LENGTH, UUID_PATTERN);
  const actorRef = readValidatedHeader(req, ACTOR_REF_HEADER, UUID_LENGTH, UUID_PATTERN);
  const gameSessionRef = readValidatedHeader(
    req,
    GAME_SESSION_REF_HEADER,
    GAME_SESSION_REF_LENGTH,
    GAME_SESSION_REF_PATTERN,
  );
  const route = req.baseUrl || req.path;
  const feature = route.split("/").filter(Boolean)[1] ?? "unknown";

  const tags: Record<string, string> = { feature };
  if (requestId) tags.requestId = requestId;
  if (actorRef) tags.actorRef = actorRef;
  if (gameSessionRef) tags.gameSessionRef = gameSessionRef;

  return {
    tags,
    extra: {
      request: {
        method: req.method,
        route,
      },
    },
  };
}
