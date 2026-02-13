import { NextRequest, NextResponse } from "next/server";
import { getClaudeClient, CLAUDE_MODEL } from "@/lib/claude";
import type { Scenario } from "@/types/game";

export const runtime = "nodejs";

interface CommandRequestBody {
  command: string;
  type: "oc" | "kql" | "geneva";
  scenario: Scenario | null;
}

export async function POST(request: NextRequest) {
  try {
    const body: CommandRequestBody = await request.json();
    const { command, type, scenario } = body;

    const client = getClaudeClient();

    const scenarioContext = scenario
      ? `
Scenario: ${scenario.title} (${scenario.difficulty})
Description: ${scenario.description}
Cluster: ${scenario.clusterContext.name}, version ${scenario.clusterContext.version}
Status: ${scenario.clusterContext.status}
Nodes: ${scenario.clusterContext.nodeCount}
Alerts: ${scenario.clusterContext.alerts.map((a) => `${a.name}: ${a.message}`).join("; ")}
Recent Events: ${scenario.clusterContext.recentEvents.join("; ")}
`
      : "No specific scenario context available.";

    const systemPrompt = `You are a command output simulator for an SRE training tool.
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

Scenario Context:
${scenarioContext}`;

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Simulate the output for this ${type} command:\n\n${command}`,
        },
      ],
    });

    let output =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Strip markdown code fences if present
    output = output.replace(/^```(?:\w*)\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    return NextResponse.json({ output, exitCode: 0 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Command simulation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
