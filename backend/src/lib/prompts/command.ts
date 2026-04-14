import { utcNow } from "../sim-clock";
import type { Scenario } from "../../../../shared/types/game";
import { formatResourceHintsForPrompt } from "./scenario-resources";

export interface CommandHistoryEntry {
  command: string;
  output: string;
  type: "oc" | "kql" | "geneva";
}

const MAX_HISTORY_ENTRIES = 24;
const MAX_HISTORY_CHARS = 12000;
const MAX_ENTRY_OUTPUT_CHARS = 800;

function formatCommandHistory(history: CommandHistoryEntry[] | undefined): string {
  if (!Array.isArray(history) || history.length === 0) return "";

  const recent = history.slice(-MAX_HISTORY_ENTRIES);

  const sanitized = recent
    .filter((h): h is CommandHistoryEntry => h != null && typeof h === "object")
    .map((h) => {
      const command = typeof h.command === "string" ? h.command : String(h.command ?? "");
      const rawOutput = typeof h.output === "string" ? h.output : String(h.output ?? "");
      const output = rawOutput.length > MAX_ENTRY_OUTPUT_CHARS
        ? rawOutput.slice(0, MAX_ENTRY_OUTPUT_CHARS) + "\n...(truncated)"
        : rawOutput;
      return { command, output };
    })
    .filter((h) => h.command !== "" || h.output !== "");

  if (sanitized.length === 0) return "";

  const lines: string[] = [];
  let totalChars = 0;

  for (const h of sanitized) {
    const line = `$ ${h.command}\n${h.output}`;
    const nextTotal = totalChars + line.length + (lines.length > 0 ? 2 : 0);
    if (nextTotal > MAX_HISTORY_CHARS) break;
    lines.push(line);
    totalChars = nextTotal;
  }

  if (lines.length === 0) return "";

  return `\n\nPreviously Executed Commands (oldest to newest):
${lines.join("\n\n")}`;
}

export function buildSimNow(reportedTime: string | undefined): string {
  const now = utcNow();
  return reportedTime
    ? `The current UTC time is ${now}. The incident ticket was originally reported at ${reportedTime}. Alerts and recent events have their own timestamps in the scenario context — use those as the temporal anchor for command output. All timestamps in your output must be in the past relative to ${now}.`
    : `The current UTC time is ${now}. Use consistent, realistic timestamps. All timestamps must be in the past relative to ${now}.`;
}

export function buildCommandSystemPrompt(
  type: string,
  scenarioContext: string,
  simNow: string,
  commandHistory?: CommandHistoryEntry[],
): string {
  const historyBlock = formatCommandHistory(commandHistory);
  return `You are a command output simulator for an SRE training tool.
Given a command and scenario context, generate realistic output that would be seen on an Azure Red Hat OpenShift cluster experiencing the described incident.

Rules:
- Output ONLY the command output, no explanations or commentary.
- Do not echo the command line, a shell prompt (e.g. starting with "$ "), a line like "[oc]" / "[kql]" / "[geneva]", or repeat the command text — the UI shows the command separately. Begin with the first line of real tool output.
- Make the output realistic and consistent with the scenario.
- Include realistic timestamps, pod names, node names, and IP addresses.
- For ${type === "oc" ? "OpenShift CLI (oc)" : type === "kql" ? "Kusto Query Language (KQL)" : "Geneva"} commands, format output appropriately.
- If the command would reveal the root cause, include subtle clues but don't make it too obvious.
- Use consistent naming: cluster name, node names, etc. from the scenario context.
- For KQL queries, format as a table with headers and rows.
- For Geneva commands, format as structured dashboard output.
- EXIT CODES AND SYSTEM OUTPUT: Use real Linux/OpenShift conventions. For systemctl status, use the actual format: "Active: active (running)" or "Active: failed" with a real numeric exit code in the "Main PID" line (e.g. "status=143/TERM", "status=1/FAILURE", "code=exited, status=1/FAILURE"). Exit codes must be integers (0=success, 1=general error, 2=misuse, 127=not found, 137=SIGKILL, 143=SIGTERM). Never use placeholder strings like "exit-status" — always use the actual numeric code.
- TEMPORAL CONSISTENCY: ${simNow} If a time range is shown (e.g. "11:00 - 13:00"), the "Last Updated" or "as of" timestamp must be at or after the end of that range. Never show a "Last Updated" time that falls before the end of the displayed time range.
- STATE CONTINUITY: If a previous command mutated cluster state (e.g. delete, scale, patch, cordon, drain, apply), subsequent command output MUST reflect that mutation. For example, if a Machine was deleted, it should not appear in a later "oc get machines" listing, or should show a "Deleting"/"Terminating" phase.
- PLACEHOLDER RESOLUTION: The user may paste angle-bracket placeholders from documentation (e.g. <machine-name>, <node>). Never echo those placeholders in simulated output. Use concrete resource names from the scenario context and the "Named resources" line below.

Scenario Context:
${scenarioContext}${historyBlock}`;
}

export function buildScenarioContext(scenario: Scenario | null): string {
  if (!scenario) return "No specific scenario context available.";
  const resourceHints = formatResourceHintsForPrompt(scenario);
  return `Title: ${scenario.title} (${scenario.difficulty})
Description: ${scenario.description}
Cluster: ${scenario.clusterContext.name}, version ${scenario.clusterContext.version}
Status: ${scenario.clusterContext.status}
Nodes: ${scenario.clusterContext.nodeCount}
Ticket reported: ${scenario.incidentTicket.reportedTime}
Alerts: ${scenario.clusterContext.alerts.map((a) => `${a.name} (firing since ${a.firingTime}): ${a.message}`).join("; ")}
Recent Events: ${scenario.clusterContext.recentEvents.join("; ")}${resourceHints}`;
}
