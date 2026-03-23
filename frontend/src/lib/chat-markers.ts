import type { InvestigationPhase } from "@shared/types/chat";
import type { ScoringEvent } from "@shared/types/scoring";

const VALID_PHASES: InvestigationPhase[] = [
  "reading", "context", "facts", "theory", "action",
];

const VALID_DIMENSIONS = ["efficiency", "safety", "documentation", "accuracy"];

export function extractPhase(content: string): InvestigationPhase | null {
  const match = content.match(/\[PHASE:(\w+)\]/);
  if (!match) return null;
  const phase = match[1] as InvestigationPhase;
  return VALID_PHASES.includes(phase) ? phase : null;
}

export function extractScoreMarkers(content: string): ScoringEvent[] {
  const events: ScoringEvent[] = [];
  const matches = content.matchAll(/\[SCORE:(\w+):([+-]\d+):([^\]]+)\]/g);
  for (const m of matches) {
    const dimension = m[1];
    if (!VALID_DIMENSIONS.includes(dimension)) continue;
    const points = parseInt(m[2], 10);
    events.push({
      type: points >= 0 ? "bonus" : "penalty",
      dimension: dimension as ScoringEvent["dimension"],
      points: Math.abs(points),
      reason: m[3],
      timestamp: Date.now(),
    });
  }
  return events;
}

export function extractResolved(content: string): boolean {
  return content.includes("[RESOLVED]");
}
