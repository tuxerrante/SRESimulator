export type AiRoute = "chat" | "command" | "scenario" | "probe";

export interface TokenUsageEntry {
  route: AiRoute;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  latencyMs: number;
  timestamp: number;
  compacted: boolean;
  compactedMessageCount: number;
}

const recentEntries: TokenUsageEntry[] = [];
const MAX_ENTRIES = 200;

const routeTotals: Record<AiRoute, { requests: number; promptTokens: number; completionTokens: number; reasoningTokens: number; errors: number }> = {
  chat: { requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, errors: 0 },
  command: { requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, errors: 0 },
  scenario: { requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, errors: 0 },
  probe: { requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, errors: 0 },
};

export function logTokenUsage(entry: TokenUsageEntry): void {
  recentEntries.push(entry);
  if (recentEntries.length > MAX_ENTRIES) {
    recentEntries.splice(0, recentEntries.length - MAX_ENTRIES);
  }

  const totals = routeTotals[entry.route];
  totals.requests += 1;
  totals.promptTokens += entry.promptTokens;
  totals.completionTokens += entry.completionTokens;
  totals.reasoningTokens += entry.reasoningTokens;

  console.log(
    `[token-usage] route=${entry.route} model=${entry.model} ` +
    `prompt=${entry.promptTokens} completion=${entry.completionTokens} ` +
    `reasoning=${entry.reasoningTokens} total=${entry.totalTokens} ` +
    `latency=${entry.latencyMs}ms` +
    (entry.compacted ? ` compacted=${entry.compactedMessageCount}msgs` : "")
  );
}

export function logTokenError(route: AiRoute, error: string): void {
  routeTotals[route].errors += 1;
  console.error(`[token-usage] route=${route} error="${error}"`);
}

export function getTokenMetrics(): {
  perRoute: typeof routeTotals;
  recentEntries: TokenUsageEntry[];
} {
  return {
    perRoute: { ...routeTotals },
    recentEntries: [...recentEntries],
  };
}
