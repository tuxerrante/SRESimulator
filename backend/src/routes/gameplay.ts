import { Router, type Request, type Response } from "express";
import { getMetricsStore, getSessionStore } from "../lib/storage";
import type { GameplayLifecycleState } from "../../../shared/types/gameplay";

export const gameplayRouter = Router();

const VALID_LIFECYCLE_STATES: GameplayLifecycleState[] = [
  "started",
  "completed",
  "abandoned",
];

interface GameplayEventBody {
  sessionToken?: string;
  lifecycleState?: GameplayLifecycleState;
  nickname?: string;
  commandCount?: number;
  commandsExecuted?: string[];
  scoringEvents?: unknown[];
  chatMessageCount?: number;
  durationMs?: number;
  scoreTotal?: number;
  grade?: string;
  metadata?: Record<string, unknown>;
}

gameplayRouter.post("/", async (req: Request, res: Response) => {
  try {
    const body: GameplayEventBody = req.body;

    if (!body.sessionToken || typeof body.sessionToken !== "string") {
      res.status(400).json({ error: "Session token is required" });
      return;
    }

    if (
      !body.lifecycleState ||
      !VALID_LIFECYCLE_STATES.includes(body.lifecycleState)
    ) {
      res.status(400).json({
        error: "Invalid lifecycle state. Must be started, completed, or abandoned.",
      });
      return;
    }

    const session = await getSessionStore().get(body.sessionToken);
    if (!session) {
      res.status(403).json({ error: "Invalid session token" });
      return;
    }

    await getMetricsStore().recordGameplay({
      sessionToken: body.sessionToken,
      nickname: typeof body.nickname === "string" ? body.nickname.trim() || undefined : undefined,
      difficulty: session.difficulty,
      scenarioTitle: session.scenarioTitle,
      lifecycleState: body.lifecycleState,
      commandCount: body.commandCount,
      commandsExecuted: Array.isArray(body.commandsExecuted) ? body.commandsExecuted : [],
      scoringEvents: Array.isArray(body.scoringEvents) ? body.scoringEvents : [],
      chatMessageCount: body.chatMessageCount,
      durationMs: body.durationMs,
      scoreTotal: body.scoreTotal,
      grade: body.grade,
      completed: body.lifecycleState === "completed",
      metadata: body.metadata ?? {},
    });

    res.status(202).json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to record gameplay event";
    res.status(500).json({ error: message });
  }
});

gameplayRouter.get("/admin", async (_req: Request, res: Response) => {
  try {
    const analytics = await getMetricsStore().getGameplayAnalytics();
    res.json(analytics);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch gameplay analytics";
    res.status(500).json({ error: message });
  }
});
