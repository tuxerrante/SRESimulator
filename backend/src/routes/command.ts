import { Router, type Request, type Response } from "express";
import { getAiReadiness } from "../lib/ai-config";
import { generateMockCommandOutput } from "../lib/mock-ai";
import { generateAiText, AiThrottledError } from "../lib/ai-runtime";
import {
  buildScenarioContext,
  buildSimNow,
  buildCommandSystemPrompt,
  type CommandHistoryEntry,
} from "../lib/prompts/command";
import { resolveAngleBracketPlaceholders } from "../lib/prompts/scenario-resources";
import type { Scenario } from "../../../shared/types/game";
import { stripTerminalCommandEcho } from "../../../shared/stripTerminalCommandEcho";

export const commandRouter = Router();
const VALID_COMMAND_TYPES = ["oc", "kql", "geneva"] as const;

interface CommandRequestBody {
  command: string;
  type: "oc" | "kql" | "geneva";
  scenario: Scenario | null;
  commandHistory?: unknown;
}

type LooseHistoryEntry = {
  command?: unknown;
  output?: unknown;
  type?: unknown;
};

const DEFAULT_MAX_COMMAND_TOKENS = 8192;
const DEFAULT_COMMAND_TIMEOUT_MS = 20000;

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function buildMockCommandResponse(command: string, type: "oc" | "kql" | "geneva") {
  return {
    output: stripTerminalCommandEcho(generateMockCommandOutput(command, type), command),
    exitCode: 0,
  };
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new CommandGenerationTimeoutError(timeoutMs));
      reject(new CommandGenerationTimeoutError(timeoutMs));
    }, timeoutMs);

    run(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        if (!timedOut) resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (timedOut && isAbortError(error)) return;
        reject(error);
      },
    );
  });
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
  try {
    const body: CommandRequestBody = req.body;
    const { command, type, scenario, commandHistory } = body;
    const commandResolved = resolveAngleBracketPlaceholders(command, scenario);
    const commandHistoryResolved = resolveCommandHistoryPlaceholders(commandHistory, scenario);

    if (!VALID_COMMAND_TYPES.includes(type)) {
      res.status(400).json({
        error: "Invalid command type. Must be oc, kql, or geneva.",
      });
      return;
    }

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
    );

    const responseText = await withTimeout(
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
      const fallbackType = VALID_COMMAND_TYPES.includes(req.body.type)
        ? req.body.type
        : "oc";
      const fallbackCommand = resolveAngleBracketPlaceholders(req.body.command, req.body.scenario);
      if (error instanceof CommandGenerationTimeoutError) {
        console.warn(
          `[command] timed out after ${getCommandTimeoutMs()}ms; returning mock fallback for ${fallbackType} command`,
        );
      }
      res.json(buildMockCommandResponse(fallbackCommand, fallbackType));
      return;
    }

    if (error instanceof AiThrottledError) {
      res.status(429).json({ error: error.message });
      return;
    }

    res.status(500).json({ error: message });
  }
});
