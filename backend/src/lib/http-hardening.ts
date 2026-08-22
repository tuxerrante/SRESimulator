import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import helmet from "helmet";

const JSON_BODY_LIMITS = {
  chat: "256kb",
  command: "128kb",
  scenario: "64kb",
  scores: "64kb",
  gameplay: "64kb",
} as const;

function createJsonBodyParser(limit: string): RequestHandler {
  return express.json({ limit });
}

type JsonBodyParserError = Error & {
  body?: unknown;
  status?: number;
  statusCode?: number;
  type?: string;
};

function mapJsonBodyParserError(
  error: JsonBodyParserError,
): { error: string; status: number } | null {
  if (
    error.type === "entity.too.large" ||
    error.status === 413 ||
    error.statusCode === 413
  ) {
    return { error: "JSON payload too large", status: 413 };
  }

  if (
    error.type === "entity.parse.failed" ||
    (error instanceof SyntaxError &&
      (error.status === 400 || error.statusCode === 400) &&
      "body" in error)
  ) {
    return { error: "Malformed JSON request body", status: 400 };
  }

  return null;
}

export const jsonRouteParsers: Record<keyof typeof JSON_BODY_LIMITS, RequestHandler> = {
  chat: createJsonBodyParser(JSON_BODY_LIMITS.chat),
  command: createJsonBodyParser(JSON_BODY_LIMITS.command),
  scenario: createJsonBodyParser(JSON_BODY_LIMITS.scenario),
  scores: createJsonBodyParser(JSON_BODY_LIMITS.scores),
  gameplay: createJsonBodyParser(JSON_BODY_LIMITS.gameplay),
};

export function applyHttpHardening(app: Express): void {
  app.disable("x-powered-by");
  app.use(helmet());
}

export const jsonBodyParserErrorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
  const response = mapJsonBodyParserError(error as JsonBodyParserError);
  if (!response) {
    next(error);
    return;
  }

  res.status(response.status).json({ error: response.error });
};
