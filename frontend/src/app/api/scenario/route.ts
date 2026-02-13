import { NextRequest, NextResponse } from "next/server";
import { getClaudeClient, CLAUDE_MODEL } from "@/lib/claude";
import { loadKnowledgeBase } from "@/lib/knowledge";
import type { Difficulty, Scenario } from "@/types/game";

export const runtime = "nodejs";

interface ScenarioRequestBody {
  difficulty: Difficulty;
}

export async function POST(request: NextRequest) {
  try {
    const body: ScenarioRequestBody = await request.json();
    const { difficulty } = body;

    const knowledgeBase = await loadKnowledgeBase();
    const client = getClaudeClient();

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: `You are a scenario generator for an ARO (Azure Red Hat OpenShift) SRE training simulator.
Generate a realistic incident scenario based on the knowledge base provided.
The scenario should be appropriate for the "${difficulty}" difficulty level.

Difficulty guidelines:
- easy: Single-component failures, obvious symptoms (e.g., node down, pods crashlooping, simple resource issues)
- medium: Networking, permissions, configuration drift, multi-component interactions
- hard: Deep obscure bugs, race conditions, distributed system failures, cascading failures

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
    "reportedTime": "ISO timestamp or relative time",
    "clusterName": "realistic-cluster-name",
    "region": "azure-region"
  },
  "clusterContext": {
    "name": "same-cluster-name",
    "version": "4.x.x",
    "region": "same-azure-region",
    "nodeCount": number,
    "status": "current status",
    "recentEvents": ["array of recent cluster events"],
    "alerts": [{"name": "alert name", "severity": "critical|warning|info", "message": "alert message", "firingTime": "timestamp"}],
    "upgradeHistory": [{"from": "4.x.x", "to": "4.x.x", "status": "completed|failed|in_progress", "timestamp": "timestamp"}]
  }
}

Knowledge Base for reference:
${knowledgeBase}`,
      messages: [
        {
          role: "user",
          content: `Generate a ${difficulty} difficulty ARO incident scenario.`,
        },
      ],
    });

    let text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    // Parse the JSON response
    const scenario: Scenario = JSON.parse(text);

    return NextResponse.json(scenario);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Scenario generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
