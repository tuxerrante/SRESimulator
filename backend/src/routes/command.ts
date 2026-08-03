import { Router, type Request, type Response } from "express";
import { getAiReadiness } from "../lib/ai-config";
import { generateMockCommandOutput } from "../lib/mock-ai";
import {
  getCommandScopeViolation,
  getRuntimePlatformProfile,
  isCommandTypeAllowedForPlatform,
} from "../lib/platform-profiles";
import { generateAiText, AiThrottledError } from "../lib/ai-runtime";
import {
  buildScenarioContext,
  buildSimNow,
  buildCommandSystemPrompt,
  type CommandHistoryEntry,
} from "../lib/prompts/command";
import { resolveAngleBracketPlaceholders } from "../lib/prompts/scenario-resources";
import { isScenario } from "../lib/scenario-validation";
import { captureBackendRouteError } from "../lib/telemetry/capture";
import { parsePositiveIntEnv } from "../lib/env";
import { getRequestSession } from "../lib/rate-limit";
import { validateSessionScenario } from "../lib/session-scenario";
import { withAbortTimeout } from "../lib/timeout";
import type { Scenario } from "../../../shared/types/game";
import type {
  CompatibleCommandType,
  PlatformId,
} from "../../../shared/types/platform";
import { stripTerminalCommandEcho } from "../../../shared/stripTerminalCommandEcho";

export const commandRouter = Router();
const VALID_COMMAND_TYPES = ["oc", "kubectl", "kql", "geneva"] as const;

interface CommandRequestBody {
  sessionToken: string;
  command: string;
  type: CompatibleCommandType;
  scenario: Scenario | null;
  commandHistory?: unknown;
}

type LooseHistoryEntry = {
  command?: unknown;
  output?: unknown;
  type?: unknown;
};

const DEFAULT_MAX_COMMAND_TOKENS = 8192;
const DEFAULT_COMMAND_TIMEOUT_MS = 12000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMaxCommandTokens(): number {
  return parsePositiveIntEnv(process.env.AI_MAX_COMMAND_TOKENS, DEFAULT_MAX_COMMAND_TOKENS);
}

function getCommandTimeoutMs(): number {
  return parsePositiveIntEnv(process.env.AI_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS);
}

class CommandGenerationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command generation timed out after ${timeoutMs}ms`);
    this.name = "CommandGenerationTimeoutError";
  }
}

function buildMockCommandResponse(
  command: string,
  type: CompatibleCommandType,
  options?: { degradedReason?: string },
) {
  const degradedReason = options?.degradedReason;
  return {
    output: stripTerminalCommandEcho(generateMockCommandOutput(command, type), command),
    exitCode: degradedReason ? 1 : 0,
    mode: degradedReason ? "degraded" : "mock",
    degradedReason,
  };
}

export function resolveCommandHistoryPlaceholders(
  commandHistory: unknown,
  scenario: Scenario | null,
): CommandHistoryEntry[] | undefined {
  if (!Array.isArray(commandHistory)) return undefined;

  return commandHistory.map((entry) => {
    if (entry == null || typeof entry !== "object") {
      return entry as CommandHistoryEntry;
    }

    const candidate = entry as LooseHistoryEntry;
    if (typeof candidate.command !== "string") {
      return entry as CommandHistoryEntry;
    }

    return {
      ...candidate,
      command: resolveAngleBracketPlaceholders(candidate.command, scenario),
    } as CommandHistoryEntry;
  });
}

commandRouter.post("/", async (req: Request, res: Response) => {
  let requestScenario: Scenario | null = null;
  let requestPlatform: PlatformId | null = null;
  let requestType: CompatibleCommandType | null = null;
  try {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const body = req.body as unknown as CommandRequestBody;
    const { command, type, commandHistory } = body;
    const rawScenario = body.scenario;
    if (rawScenario != null && !isScenario(rawScenario)) {
      res.status(400).json({ error: "Invalid scenario payload" });
      return;
    }
    if (typeof body.sessionToken !== "string" || body.sessionToken.trim() === "") {
      res.status(400).json({ error: "Session token is required" });
      return;
    }
    if (typeof command !== "string" || command.trim() === "") {
      res.status(400).json({ error: "Command is required" });
      return;
    }
    if (!VALID_COMMAND_TYPES.includes(type)) {
      res.status(400).json({
        error: "Invalid command type. Must be oc, kubectl, kql, or geneva.",
      });
      return;
    }
    requestType = type;

    const session = await getRequestSession(req, body.sessionToken);
    if (!session || session.used) {
      res.status(403).json({ error: "Invalid or expired session token" });
      return;
    }
    requestPlatform = session.platform;
    const scenarioResult = validateSessionScenario(session, rawScenario);
    if (!scenarioResult.ok) {
      res.status(409).json({ error: scenarioResult.error });
      return;
    }
    const scenario = scenarioResult.scenario;
    requestScenario = scenario;
    const profile = getRuntimePlatformProfile(session.platform);

    if (!isCommandTypeAllowedForPlatform(session.platform, type)) {
      res.status(409).json({
        error: `Command type ${type} does not match platform ${session.platform}`,
      });
      return;
    }
    const scopeViolation = getCommandScopeViolation(
      session.platform,
      type,
      command,
    );
    if (scopeViolation) {
      res.status(409).json({
        error: `${scopeViolation} does not match platform ${session.platform}`,
      });
      return;
    }

    const commandResolved = resolveAngleBracketPlaceholders(command, scenario);
    const commandHistoryResolved = resolveCommandHistoryPlaceholders(commandHistory, scenario);

    const readiness = getAiReadiness();
    if (readiness.mockMode) {
      res.json(buildMockCommandResponse(commandResolved, type));
      return;
    }
    if (!readiness.ready) {
      res.status(503).json({
        error: "AI runtime configuration is invalid",
        details: readiness.reasons,
      });
      return;
    }

    const scenarioContext = buildScenarioContext(scenario);
    const simNow = buildSimNow(scenario?.incidentTicket?.reportedTime);
    const systemPrompt = buildCommandSystemPrompt(
      type,
      scenarioContext,
      simNow,
      commandHistoryResolved,
      profile,
    );

    const responseText = await withAbortTimeout(
      (signal) =>
        generateAiText({
          maxTokens: getMaxCommandTokens(),
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: `Simulate the output for this ${type} command:\n\n${commandResolved}`,
            },
          ],
          route: "command",
          signal,
        }),
      getCommandTimeoutMs(),
      (timeoutMs) => new CommandGenerationTimeoutError(timeoutMs),
      { suppressAbortErrorAfterTimeout: true },
    );

    let output = responseText;
    output = output.replace(/^```(?:\w*)\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    output = stripTerminalCommandEcho(output, commandResolved);

    res.json({ output, exitCode: 0 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Command simulation failed";

    if (
      error instanceof CommandGenerationTimeoutError ||
      message.includes("without output text") ||
      message.includes("did not include text content")
    ) {
      captureBackendRouteError(req, error);
      const requestBody = isRecord(req.body) ? req.body : {};
      const fallbackType = typeof requestBody.type === "string" &&
          VALID_COMMAND_TYPES.includes(requestBody.type as (typeof VALID_COMMAND_TYPES)[number])
        ? (requestBody.type as (typeof VALID_COMMAND_TYPES)[number])
        : requestType ??
          (requestPlatform
            ? getRuntimePlatformProfile(requestPlatform).primaryCli
            : "oc");
      const fallbackCommandRaw = typeof requestBody.command === "string" ? requestBody.command : "";
      const fallbackScenario = requestScenario ?? (isScenario(requestBody.scenario)
        ? requestBody.scenario
        : null);
      const fallbackCommand = resolveAngleBracketPlaceholders(
        fallbackCommandRaw,
        fallbackScenario,
      );
      if (error instanceof CommandGenerationTimeoutError) {
        console.warn(
          `[command] timed out after ${getCommandTimeoutMs()}ms; returning mock fallback for ${fallbackType} command`,
        );
      }
      res.json(
        buildMockCommandResponse(fallbackCommand, fallbackType, {
          degradedReason:
            error instanceof CommandGenerationTimeoutError
              ? "timeout"
              : "missing_output",
        }),
      );
      return;
    }

    if (error instanceof AiThrottledError) {
      res.status(429).json({ error: error.message });
      return;
    }

    captureBackendRouteError(req, error);
    res.status(500).json({ error: "Command simulation failed" });
  }
});
