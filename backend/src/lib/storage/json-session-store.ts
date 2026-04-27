import type { Difficulty } from "../../../../shared/types/game";
import type { CreateGameSessionInput, ISessionStore, GameSession } from "./types";

const sessions = new Map<string, GameSession>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.startTime > SESSION_TTL_MS) {
      sessions.delete(token);
    }
  }
}

export class JsonSessionStore implements ISessionStore {
  async create(input: CreateGameSessionInput): Promise<string>;
  async create(difficulty: Difficulty, scenarioTitle: string): Promise<string>;
  async create(
    difficultyOrInput: Difficulty | CreateGameSessionInput,
    scenarioTitle?: string
  ): Promise<string> {
    cleanup();
    const token = crypto.randomUUID();
    const input: CreateGameSessionInput =
      typeof difficultyOrInput === "string"
        ? {
            difficulty: difficultyOrInput,
            scenarioTitle: scenarioTitle ?? "Unknown Scenario",
            identityKind: "anonymous",
            anonymousClaimKey: null,
            githubLogin: null,
            githubUserId: null,
            persistentScoreEligible: false,
          }
        : difficultyOrInput;
    sessions.set(token, {
      token,
      difficulty: input.difficulty,
      scenarioTitle: input.scenarioTitle,
      startTime: Date.now(),
      used: false,
      identityKind: input.identityKind,
      githubUserId: input.githubUserId ?? null,
      githubLogin: input.githubLogin ?? null,
      anonymousClaimKey: input.anonymousClaimKey ?? null,
      persistentScoreEligible: input.persistentScoreEligible,
    });
    return token;
  }

  async get(token: string): Promise<GameSession | null> {
    cleanup();
    return sessions.get(token) ?? null;
  }

  async validateAndConsume(token: string): Promise<GameSession | null> {
    cleanup();
    const session = sessions.get(token);
    if (!session || session.used) return null;
    session.used = true;
    return session;
  }
}
