import { Router, type Request, type Response } from "express";
import { getAiReadiness } from "../lib/ai-config";
import { generateMockCommandOutput } from "../lib/mock-ai";
import { generateAiText, AiThrottledError } from "../lib/ai-runtime";
import {
  buildScenarioContext,
  buildSimNow,
  buildCommandSystemPrompt,
} from "../lib/prompts/command";
import type { Scenario } from "../../../shared/types/game";
import { stripTerminalCommandEcho } from "../../../shared/stripTerminalCommandEcho";

export const commandRouter = Router();
const VALID_COMMAND_TYPES = ["oc", "kql", "geneva"] as const;

interface CommandRequestBody {
  command: string;
  type: "oc" | "kql" | "geneva";
  scenario: Scenario | null;
  commandHistory?: { command: string; output: string; type: "oc" | "kql" | "geneva" }[];
}

commandRouter.post("/", async (req: Request, res: Response) => {
  try {
    const body: CommandRequestBody = req.body;
    const { command, type, scenario, commandHistory } = body;

    if (!VALID_COMMAND_TYPES.includes(type)) {
      res.status(400).json({
        error: "Invalid command type. Must be oc, kql, or geneva.",
      });
      return;
    }

    const readiness = getAiReadiness();
    if (readiness.mockMode) {
      const raw = generateMockCommandOutput(command, type);
      res.json({
        output: stripTerminalCommandEcho(raw, command),
        exitCode: 0,
      });
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
    const systemPrompt = buildCommandSystemPrompt(type, scenarioContext, simNow, commandHistory);

    const responseText = await generateAiText({
      maxTokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Simulate the output for this ${type} command:\n\n${command}`,
        },
      ],
      route: "command",
    });

    let output = responseText;
    output = output.replace(/^```(?:\w*)\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    output = stripTerminalCommandEcho(output, command);

    res.json({ output, exitCode: 0 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Command simulation failed";

    if (
      message.includes("without output text") ||
      message.includes("did not include text content")
    ) {
      res.json({
        output: stripTerminalCommandEcho(
          generateMockCommandOutput(req.body.command, req.body.type),
          req.body.command,
        ),
        exitCode: 0,
      });
      return;
    }

    if (error instanceof AiThrottledError) {
      res.status(429).json({ error: error.message });
      return;
    }

    res.status(500).json({ error: message });
  }
});
