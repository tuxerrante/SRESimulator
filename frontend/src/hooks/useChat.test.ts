import { describe, expect, it } from "vitest";
import type { InvestigationPhase } from "@shared/types/chat";
import type { ScoringEvent } from "@shared/types/scoring";

const VALID_PHASES: InvestigationPhase[] = [
  "reading",
  "context",
  "facts",
  "theory",
  "action",
];

const VALID_DIMENSIONS = ["efficiency", "safety", "documentation", "accuracy"];

function extractPhase(content: string): InvestigationPhase | null {
  const match = content.match(/\[PHASE:(\w+)\]/);
  if (!match) return null;
  const phase = match[1] as InvestigationPhase;
  return VALID_PHASES.includes(phase) ? phase : null;
}

function extractScoreMarkers(content: string): ScoringEvent[] {
  const events: ScoringEvent[] = [];
  const pattern = /\[SCORE:(\w+):([+-]\d+):([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
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

function extractResolved(content: string): boolean {
  return content.includes("[RESOLVED]");
}

describe("extractPhase", () => {
  it("extracts a valid phase marker", () => {
    expect(extractPhase("Some text [PHASE:context] more text")).toBe("context");
  });

  it("returns null when no phase marker exists", () => {
    expect(extractPhase("No phase here")).toBeNull();
  });

  it("returns null for invalid phase value", () => {
    expect(extractPhase("[PHASE:invalid]")).toBeNull();
  });

  it.each(VALID_PHASES)("recognizes phase: %s", (phase) => {
    expect(extractPhase(`[PHASE:${phase}]`)).toBe(phase);
  });
});

describe("extractScoreMarkers", () => {
  it("extracts bonus score events", () => {
    const events = extractScoreMarkers("[SCORE:efficiency:+5:Good work]");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("bonus");
    expect(events[0].dimension).toBe("efficiency");
    expect(events[0].points).toBe(5);
    expect(events[0].reason).toBe("Good work");
  });

  it("extracts penalty score events", () => {
    const events = extractScoreMarkers("[SCORE:safety:-3:Unsafe action]");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("penalty");
    expect(events[0].points).toBe(3);
  });

  it("extracts multiple score events", () => {
    const content =
      "[SCORE:efficiency:+2:Fast] some text [SCORE:safety:-1:Risky]";
    const events = extractScoreMarkers(content);
    expect(events).toHaveLength(2);
  });

  it("ignores invalid dimension names", () => {
    const events = extractScoreMarkers("[SCORE:bogus:+5:Nope]");
    expect(events).toHaveLength(0);
  });

  it("returns empty array when no markers exist", () => {
    expect(extractScoreMarkers("No markers here")).toEqual([]);
  });
});

describe("extractResolved", () => {
  it("returns true when [RESOLVED] marker present", () => {
    expect(extractResolved("The issue is [RESOLVED] now")).toBe(true);
  });

  it("returns false when no marker present", () => {
    expect(extractResolved("Still investigating")).toBe(false);
  });
});
