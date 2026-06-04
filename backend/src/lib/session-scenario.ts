import { isScenario } from "./scenario-validation";
import type { GameSession } from "./storage/types";
import type { Scenario } from "../../../shared/types/game";

interface ParsedSessionScenario {
  scenario: Scenario | null;
  hasPayload: boolean;
}

type SessionScenarioValidationResult =
  | { ok: true; scenario: Scenario | null }
  | { ok: false; error: string };

function parseSessionScenario(sessionPayload: string | null): ParsedSessionScenario {
  if (!sessionPayload || sessionPayload.trim() === "") {
    return { scenario: null, hasPayload: false };
  }
  try {
    const parsed = JSON.parse(sessionPayload);
    return { scenario: isScenario(parsed) ? parsed : null, hasPayload: true };
  } catch {
    return { scenario: null, hasPayload: true };
  }
}

export function validateSessionScenario(
  session: Pick<GameSession, "scenarioPayload" | "scenarioTitle" | "difficulty" | "scenarioId">,
  rawScenario: Scenario | null,
): SessionScenarioValidationResult {
  const parsedSessionScenario = parseSessionScenario(session.scenarioPayload);
  const storedScenario = parsedSessionScenario.scenario;

  if (parsedSessionScenario.hasPayload && !storedScenario) {
    return { ok: false, error: "Session scenario context is unavailable" };
  }

  if (storedScenario) {
    if (
      storedScenario.title !== session.scenarioTitle ||
      storedScenario.difficulty !== session.difficulty ||
      (session.scenarioId && storedScenario.id !== session.scenarioId)
    ) {
      return { ok: false, error: "Scenario does not match the active session" };
    }
    if (
      rawScenario &&
      (rawScenario.id !== storedScenario.id ||
        rawScenario.title !== storedScenario.title ||
        rawScenario.difficulty !== storedScenario.difficulty)
    ) {
      return { ok: false, error: "Scenario payload integrity check failed" };
    }
    return { ok: true, scenario: storedScenario };
  }

  if (
    rawScenario &&
    (rawScenario.difficulty !== session.difficulty ||
      rawScenario.title !== session.scenarioTitle ||
      (session.scenarioId && rawScenario.id !== session.scenarioId))
  ) {
    return { ok: false, error: "Scenario does not match the active session" };
  }

  return { ok: true, scenario: rawScenario ?? null };
}
