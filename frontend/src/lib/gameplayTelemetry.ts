import type { InvestigationPhase } from "@shared/types/chat";
import type { GameStatus, Scenario } from "@shared/types/game";
import type { GameplayLifecycleState, GameplayTelemetryEvent } from "@shared/types/gameplay";
import type { Score, ScoringEvent } from "@shared/types/scoring";
import type { TerminalEntry } from "@shared/types/terminal";

export interface GameplayTelemetryStateSnapshot {
  status: GameStatus;
  nickname: string | null;
  sessionToken: string | null;
  scenario: Scenario | null;
  startTime: number | null;
  currentPhase: InvestigationPhase;
  phaseHistory: InvestigationPhase[];
  checkedDashboard: boolean;
  terminalEntries: TerminalEntry[];
  commandCount: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  score: Score;
  scoringEvents: ScoringEvent[];
}

const COMPLETION_SENT_KEY_PREFIX = "gameplay-telemetry-completed:";

export function scoreToGrade(totalScore: number): string {
  if (totalScore >= 90) return "A";
  if (totalScore >= 80) return "B";
  if (totalScore >= 70) return "C";
  if (totalScore >= 60) return "D";
  return "F";
}

export function buildGameplayTelemetryPayload(
  state: GameplayTelemetryStateSnapshot,
  lifecycleState: GameplayLifecycleState,
  now: number = Date.now(),
): GameplayTelemetryEvent {
  if (!state.sessionToken) {
    throw new Error("Cannot build gameplay telemetry without a session token");
  }

  const durationMs = state.startTime != null ? Math.max(0, now - state.startTime) : undefined;

  const payload: GameplayTelemetryEvent = {
    sessionToken: state.sessionToken,
    lifecycleState,
    nickname: state.nickname ?? undefined,
    commandCount: state.commandCount,
    commandsExecuted: state.terminalEntries.map((entry) => entry.command),
    scoringEvents: state.scoringEvents,
    chatMessageCount: state.messages.filter((message) => message.role === "user").length,
    durationMs,
    metadata: {
      currentPhase: state.currentPhase,
      phaseHistory: state.phaseHistory,
      checkedDashboard: state.checkedDashboard,
      scenarioId: state.scenario?.id,
      scenarioTitle: state.scenario?.title,
    },
  };

  if (lifecycleState === "completed") {
    payload.scoreTotal = state.score.total;
    payload.grade = scoreToGrade(state.score.total);
  }

  return payload;
}

export function shouldSendAbandonmentEvent(
  state: GameplayTelemetryStateSnapshot,
): boolean {
  return state.status === "playing" && !!state.sessionToken && !!state.scenario;
}

export function hasCompletionTelemetryBeenSent(sessionToken: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(`${COMPLETION_SENT_KEY_PREFIX}${sessionToken}`) === "1";
  } catch {
    return false;
  }
}

export function markCompletionTelemetrySent(sessionToken: string): void {
  try {
    globalThis.sessionStorage?.setItem(`${COMPLETION_SENT_KEY_PREFIX}${sessionToken}`, "1");
  } catch {
    // Ignore storage restrictions; duplicate protection is best-effort.
  }
}

export async function sendCompletionTelemetryIfNeeded(
  state: GameplayTelemetryStateSnapshot,
): Promise<boolean> {
  const sessionToken = state.sessionToken;
  if (!sessionToken || hasCompletionTelemetryBeenSent(sessionToken)) {
    return false;
  }

  const delivered = await sendGameplayTelemetryEvent(
    buildGameplayTelemetryPayload(state, "completed"),
  );
  if (delivered) {
    markCompletionTelemetrySent(sessionToken);
  }

  return delivered;
}

export async function sendGameplayTelemetryEvent(
  payload: GameplayTelemetryEvent,
): Promise<boolean> {
  const body = JSON.stringify(payload);

  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      const queued = navigator.sendBeacon("/api/gameplay", blob);
      if (queued) {
        return true;
      }
    }
  } catch {
    // Fall back to fetch below.
  }

  if (typeof fetch !== "function") {
    return false;
  }

  try {
    const response = await fetch("/api/gameplay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}
