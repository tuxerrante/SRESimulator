import { Router, type Request, type Response } from "express";
import { loadKnowledgeBase } from "../lib/knowledge";
import { getMetricsStore, getSessionStore } from "../lib/storage";
import { getAiReadiness } from "../lib/ai-config";
import { generateMockScenario } from "../lib/mock-ai";
import { generateAiText, AiThrottledError } from "../lib/ai-runtime";
import { utcNow } from "../lib/sim-clock";
import type { Difficulty, Scenario } from "../../../shared/types/game";

export const scenarioRouter = Router();
const VALID_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

interface ScenarioRequestBody {
  difficulty: Difficulty;
}

scenarioRouter.post("/", async (req: Request, res: Response) => {
  try {
    const body: ScenarioRequestBody = req.body;
    const { difficulty } = body;

    if (!VALID_DIFFICULTIES.includes(difficulty)) {
      res.status(400).json({
        error: "Invalid difficulty. Must be easy, medium, or hard.",
      });
      return;
    }

    const readiness = getAiReadiness();
    if (readiness.mockMode) {
      const scenario = generateMockScenario(difficulty);
      const sessionToken = await getSessionStore().create(difficulty, scenario.title);
      await getMetricsStore().recordGameplay({
        sessionToken,
        difficulty,
        scenarioTitle: scenario.title,
        lifecycleState: "started",
        completed: false,
        metadata: { source: "scenario" },
      });
      res.json({ scenario, sessionToken });
      return;
    }
    if (!readiness.ready) {
      res.status(503).json({
        error: "AI runtime configuration is invalid",
        details: readiness.reasons,
      });
      return;
    }

    const knowledgeBase = await loadKnowledgeBase();

    // Extract only scenario-relevant context from the knowledge base
    const scenarioContext = knowledgeBase
      .split("\n")
      .filter((line) => {
        const l = line.trim().toLowerCase();
        return (
          l.startsWith("#") ||
          l.startsWith("- ") ||
          l.includes("alert") ||
          l.includes("scenario") ||
          l.includes("symptom") ||
          l.includes("error") ||
          l.includes("failure") ||
          l.includes("cluster") ||
          l.includes("node") ||
          l.includes("pod") ||
          l.includes("version") ||
          l === ""
        );
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      // Keep scenario generation fast by limiting prompt context size.
      .slice(0, 6000);

    const currentDate = utcNow();

    const responseText = await generateAiText({
      maxTokens: 1024,
      route: "scenario",
      system: `You are a scenario generator for an ARO (Azure Red Hat OpenShift) SRE training simulator.
Generate a realistic incident scenario. Be concise.
The scenario should be appropriate for the "${difficulty}" difficulty level.

Difficulty guidelines:
- easy: Single-component failures, obvious symptoms (e.g., node down, pods crashlooping, simple resource issues)
- medium: Networking, permissions, configuration drift, multi-component interactions
- hard: Deep obscure bugs, race conditions, distributed system failures, cascading failures

Use currently supported ARO versions (4.16–4.20). For easy scenarios, you may use 4.15 (EOL) to test "upgrade your cluster" awareness.

IMPORTANT — timestamps: The current date/time is ${currentDate}. Generate realistic ISO 8601 timestamps — the incident reportedTime should be within the past 1–7 days, while recentEvents and alert firingTimes should be more recent (minutes to hours ago) to feel like a live incident. Upgrade history timestamps can be older. Do NOT use placeholder or obviously fake dates.

IMPORTANT: Respond with ONLY valid JSON matching this exact structure (no markdown, no code fences):
{
  "id": "scenario_xxx",
  "title": "Short descriptive title",
  "difficulty": "${difficulty}",
  "description": "Brief description of what's wrong (for AI context, not shown to user directly)",
  "incidentTicket": {
    "id": "IcM-XXXXXX",
    "severity": "Sev1|Sev2|Sev3|Sev4",
    "title": "Customer-facing incident title",
    "description": "What the customer or monitoring reported",
    "customerImpact": "Description of impact",
    "reportedTime": "ISO 8601 timestamp within the past 1–7 days",
    "clusterName": "realistic-cluster-name",
    "region": "azure-region"
  },
  "clusterContext": {
    "name": "same-cluster-name",
    "version": "4.x.x",
    "region": "same-azure-region",
    "nodeCount": number,
    "status": "current status",
    "recentEvents": ["array of recent cluster events with ISO timestamps"],
    "alerts": [{"name": "alert name", "severity": "critical|warning|info", "message": "alert message", "firingTime": "ISO timestamp"}],
    "upgradeHistory": [{"from": "4.x.x", "to": "4.x.x", "status": "completed|failed|in_progress", "timestamp": "ISO timestamp"}]
  }
}

Reference incidents and alerts:
${scenarioContext}`,
      messages: [
        {
          role: "user",
          content: `Generate a ${difficulty} difficulty ARO incident scenario.`,
        },
      ],
    });

    let text = responseText;

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    const scenario: Scenario = JSON.parse(text);

    const sessionToken = await getSessionStore().create(difficulty, scenario.title);
    await getMetricsStore().recordGameplay({
      sessionToken,
      difficulty,
      scenarioTitle: scenario.title,
      lifecycleState: "started",
      completed: false,
      metadata: { source: "scenario" },
    });

    res.json({ scenario, sessionToken });
  } catch (error) {
    if (error instanceof AiThrottledError) {
      res.status(429).json({ error: error.message });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Scenario generation failed";
    res.status(500).json({ error: message });
  }
});
