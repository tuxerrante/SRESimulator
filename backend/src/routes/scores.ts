import { Router, type Request, type Response } from "express";
import { addEntry, getLeaderboard, getHallOfFame } from "../lib/leaderboard";
import { validateAndConsumeSession } from "../lib/sessions";
import type { Difficulty } from "../../../shared/types/game";
import type { LeaderboardEntry } from "../../../shared/types/leaderboard";

export const scoresRouter = Router();

const VALID_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

scoresRouter.get("/", async (req: Request, res: Response) => {
  try {
    const difficulty = req.query.difficulty as Difficulty | undefined;

    if (difficulty && !VALID_DIFFICULTIES.includes(difficulty)) {
      res.status(400).json({
        error: "Invalid difficulty. Must be easy, medium, or hard.",
      });
      return;
    }

    const entries = await getLeaderboard(difficulty);
    const hallOfFame = await getHallOfFame();

    res.json({ entries, hallOfFame });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch leaderboard";
    res.status(500).json({ error: message });
  }
});

scoresRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { sessionToken, nickname, score, grade, commandCount } = req.body;

    if (!sessionToken || typeof sessionToken !== "string") {
      res.status(400).json({ error: "Session token is required" });
      return;
    }
    const session = validateAndConsumeSession(sessionToken);
    if (!session) {
      res.status(403).json({
        error: "Invalid or already used session token",
      });
      return;
    }

    if (!nickname || typeof nickname !== "string" || nickname.trim().length === 0) {
      res.status(400).json({ error: "Nickname is required" });
      return;
    }
    if (nickname.length > 20) {
      res.status(400).json({ error: "Nickname must be 20 characters or less" });
      return;
    }
    if (!score || typeof score.total !== "number") {
      res.status(400).json({ error: "Invalid score" });
      return;
    }

    const durationMs = Date.now() - session.startTime;

    const entry: LeaderboardEntry = {
      id: crypto.randomUUID(),
      nickname: nickname.trim(),
      difficulty: session.difficulty,
      score,
      grade,
      commandCount,
      durationMs,
      scenarioTitle: session.scenarioTitle,
      timestamp: Date.now(),
    };

    const saved = await addEntry(entry);
    res.status(201).json(saved);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save score";
    res.status(500).json({ error: message });
  }
});
