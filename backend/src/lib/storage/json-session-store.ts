import type { Difficulty } from "../../../../shared/types/game";
import type { ISessionStore, GameSession } from "./types";

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
  async create(difficulty: Difficulty, scenarioTitle: string): Promise<string> {
    cleanup();
    const token = crypto.randomUUID();
    sessions.set(token, {
      token,
      difficulty,
      scenarioTitle,
      startTime: Date.now(),
      used: false,
    });
    return token;
  }

  async validateAndConsume(token: string): Promise<GameSession | null> {
    cleanup();
    const session = sessions.get(token);
    if (!session || session.used) return null;
    session.used = true;
    return session;
  }
}
