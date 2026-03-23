export type AiRoute = "chat" | "command" | "scenario" | "probe";

export interface TokenUsageEntry {
  route: AiRoute;
  model: string;
  deployment?: string;
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

interface RouteTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  errors: number;
}

function emptyTotals(): RouteTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, errors: 0 };
}

const routeTotals: Record<AiRoute, RouteTotals> = {
  chat: emptyTotals(),
  command: emptyTotals(),
  scenario: emptyTotals(),
  probe: emptyTotals(),
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

  const deploymentTag = entry.deployment ? ` deployment=${entry.deployment}` : "";
  console.log(
    `[token-usage] route=${entry.route} model=${entry.model}${deploymentTag} ` +
    `prompt=${entry.promptTokens} completion=${entry.completionTokens} ` +
    `reasoning=${entry.reasoningTokens} total=${entry.totalTokens} ` +
    `latency=${entry.latencyMs}ms` +
    (entry.compacted ? ` compacted=${entry.compactedMessageCount}msgs` : "")
  );
}

function sanitizeLogString(s: string): string {
  return s.replace(/[\r\n"\\]/g, " ").slice(0, 200);
}

export function logTokenError(route: AiRoute, error: string): void {
  routeTotals[route].errors += 1;
  console.error(`[token-usage] route=${route} error="${sanitizeLogString(error)}"`);
}

export function getTokenMetrics(): {
  perRoute: typeof routeTotals;
  recentEntries: TokenUsageEntry[];
} {
  return {
    perRoute: Object.fromEntries(
      Object.entries(routeTotals).map(([route, totals]) => [route, { ...totals }]),
    ) as typeof routeTotals,
    recentEntries: recentEntries.map((entry) => ({ ...entry })),
  };
}

// ts-unused-exports:disable-next-line
export function _resetForTests(): void {
  recentEntries.length = 0;
  for (const route of Object.keys(routeTotals) as AiRoute[]) {
    Object.assign(routeTotals[route], emptyTotals());
  }
}
