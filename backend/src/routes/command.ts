import { Router, type Request, type Response } from "express";
import { getAiReadiness } from "../lib/ai-config";
import { generateMockCommandOutput } from "../lib/mock-ai";
import { generateAiText } from "../lib/ai-runtime";
import type { Scenario } from "../../../shared/types/game";

export const commandRouter = Router();
const VALID_COMMAND_TYPES = ["oc", "kql", "geneva"] as const;

interface CommandRequestBody {
  command: string;
  type: "oc" | "kql" | "geneva";
  scenario: Scenario | null;
}

function buildCommandSystemPrompt(type: string, scenarioContext: string, simNow: string): string {
  return `You are a command output simulator for an SRE training tool.
Given a command and scenario context, generate realistic output that would be seen on an Azure Red Hat OpenShift cluster experiencing the described incident.

Rules:
- Output ONLY the command output, no explanations or commentary.
- Make the output realistic and consistent with the scenario.
- Include realistic timestamps, pod names, node names, and IP addresses.
- For ${type === "oc" ? "OpenShift CLI (oc)" : type === "kql" ? "Kusto Query Language (KQL)" : "Geneva"} commands, format output appropriately.
- If the command would reveal the root cause, include subtle clues but don't make it too obvious.
- Use consistent naming: cluster name, node names, etc. from the scenario context.
- For KQL queries, format as a table with headers and rows.
- For Geneva commands, format as structured dashboard output.
- EXIT CODES AND SYSTEM OUTPUT: Use real Linux/OpenShift conventions. For systemctl status, use the actual format: "Active: active (running)" or "Active: failed" with a real numeric exit code in the "Main PID" line (e.g. "status=143/TERM", "status=1/FAILURE", "code=exited, status=1/FAILURE"). Exit codes must be integers (0=success, 1=general error, 2=misuse, 127=not found, 137=SIGKILL, 143=SIGTERM). Never use placeholder strings like "exit-status" — always use the actual numeric code.
- TEMPORAL CONSISTENCY: ${simNow} If a time range is shown (e.g. "11:00 - 13:00"), the "Last Updated" or "as of" timestamp must be at or after the end of that range. Never show a "Last Updated" time that falls before the end of the displayed time range.

Scenario Context:
${scenarioContext}`;
}

function buildScenarioContext(scenario: Scenario | null): string {
  if (!scenario) return "No specific scenario context available.";
  return `Title: ${scenario.title} (${scenario.difficulty})
Description: ${scenario.description}
Cluster: ${scenario.clusterContext.name}, version ${scenario.clusterContext.version}
Status: ${scenario.clusterContext.status}
Nodes: ${scenario.clusterContext.nodeCount}
Alerts: ${scenario.clusterContext.alerts.map((a) => `${a.name}: ${a.message}`).join("; ")}
Recent Events: ${scenario.clusterContext.recentEvents.join("; ")}`;
}

commandRouter.post("/", async (req: Request, res: Response) => {
  try {
    const body: CommandRequestBody = req.body;
    const { command, type, scenario } = body;

    if (!VALID_COMMAND_TYPES.includes(type)) {
      res.status(400).json({
        error: "Invalid command type. Must be oc, kql, or geneva.",
      });
      return;
    }

    const readiness = getAiReadiness();
    if (readiness.mockMode) {
      res.json({
        output: generateMockCommandOutput(command, type),
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

    const reportedTime = scenario?.incidentTicket?.reportedTime;
    const simNow = reportedTime
      ? `The incident was reported at ${reportedTime}. The current simulation time is approximately 1-2 hours after the reported time. All timestamps in your output must be in the past relative to this current time.`
      : "Use consistent, realistic timestamps. All timestamps must be in the past relative to the current time shown in any dashboard or query output.";

    const systemPrompt = buildCommandSystemPrompt(type, scenarioContext, simNow);

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

    res.json({ output, exitCode: 0 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Command simulation failed";

    if (
      message.includes("without output text") ||
      message.includes("did not include text content")
    ) {
      res.json({
        output: generateMockCommandOutput(req.body.command, req.body.type),
        exitCode: 0,
      });
      return;
    }

    res.status(500).json({ error: message });
  }
});
