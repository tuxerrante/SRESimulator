import { Router, type Request, type Response } from "express";
import { getLeaderboardStore, getMetricsStore, getSessionStore } from "../lib/storage";
import { isCleanNickname } from "../lib/profanity";
import { captureBackendRouteError } from "../lib/telemetry/capture";
import type { Difficulty } from "../../../shared/types/game";
import type { LeaderboardEntry } from "../../../shared/types/leaderboard";
import {
  MAX_SCORE_PER_DIMENSION,
  MAX_TOTAL_SCORE,
  type Score,
} from "../../../shared/types/scoring";

export const scoresRouter = Router();

const VALID_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const SCORE_DIMENSIONS = [
  "efficiency",
  "safety",
  "documentation",
  "accuracy",
] as const;
type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isBoundedScoreValue = (value: number, max: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= max;

function isScoreDimension(value: unknown): value is ScoreDimension {
  return typeof value === "string" && SCORE_DIMENSIONS.includes(value as ScoreDimension);
}

function calculateScoreFromEvents(rawEvents: unknown): Score | null {
  if (!Array.isArray(rawEvents)) {
    return null;
  }

  const score: Score = {
    efficiency: 0,
    safety: 0,
    documentation: 0,
    accuracy: 0,
    total: 0,
  };

  for (const rawEvent of rawEvents) {
    if (!isRecord(rawEvent)) {
      continue;
    }
    const type = rawEvent.type;
    const dimension = rawEvent.dimension;
    const points = rawEvent.points;
    if (
      (type !== "bonus" && type !== "penalty") ||
      !isScoreDimension(dimension) ||
      typeof points !== "number" ||
      !Number.isFinite(points) ||
      points < 0
    ) {
      continue;
    }
    const delta = type === "bonus" ? points : -points;
    score[dimension] = Math.max(
      0,
      Math.min(MAX_SCORE_PER_DIMENSION, score[dimension] + delta),
    );
  }

  score.total =
    score.efficiency + score.safety + score.documentation + score.accuracy;
  if (!isBoundedScoreValue(score.total, MAX_TOTAL_SCORE)) {
    return null;
  }

  return score;
}

function scoreToGrade(totalScore: number): string {
  if (totalScore >= 90) return "A";
  if (totalScore >= 80) return "B";
  if (totalScore >= 70) return "C";
  if (totalScore >= 60) return "D";
  return "F";
}

scoresRouter.get("/", async (req: Request, res: Response) => {
  try {
    const difficulty = req.query.difficulty as Difficulty | undefined;

    if (difficulty && !VALID_DIFFICULTIES.includes(difficulty)) {
      res.status(400).json({
        error: "Invalid difficulty. Must be easy, medium, or hard.",
      });
      return;
    }

    const leaderboard = getLeaderboardStore();
    const entries = await leaderboard.getLeaderboard(difficulty);
    const hallOfFame = await leaderboard.getHallOfFame();

    res.json({ entries, hallOfFame });
  } catch (error) {
    captureBackendRouteError(req, error);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

scoresRouter.post("/", async (req: Request, res: Response) => {
  try {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const { sessionToken, nickname } = req.body;

    if (!sessionToken || typeof sessionToken !== "string") {
      res.status(400).json({ error: "Session token is required" });
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
    const nicknameCheck = isCleanNickname(nickname);
    if (!nicknameCheck.clean) {
      res.status(400).json({ error: nicknameCheck.reason });
      return;
    }
    const existingSession = await getSessionStore().get(sessionToken);
    if (!existingSession || existingSession.used) {
      res.status(403).json({
        error: "Invalid or already used session token",
      });
      return;
    }

    const gameplayRecord = await getMetricsStore().getLatestBySessionToken(sessionToken);
    if (!gameplayRecord || gameplayRecord.lifecycleState !== "completed") {
      res.status(409).json({ error: "Completion telemetry is required before submitting a score" });
      return;
    }
    if (
      gameplayRecord.difficulty &&
      gameplayRecord.difficulty !== existingSession.difficulty
    ) {
      res.status(409).json({ error: "Session telemetry mismatch" });
      return;
    }
    if (
      gameplayRecord.scenarioTitle &&
      gameplayRecord.scenarioTitle !== existingSession.scenarioTitle
    ) {
      res.status(409).json({ error: "Session telemetry mismatch" });
      return;
    }

    const score = calculateScoreFromEvents(gameplayRecord.scoringEvents);
    if (!score) {
      res.status(409).json({ error: "Completion telemetry is missing scoring events" });
      return;
    }
    const commandCount = Number.isFinite(gameplayRecord.commandCount)
      ? Math.max(0, Math.trunc(gameplayRecord.commandCount ?? 0))
      : (gameplayRecord.commandsExecuted?.length ?? 0);
    const grade = scoreToGrade(score.total);

    const session = await getSessionStore().validateAndConsume(sessionToken);
    if (!session) {
      res.status(403).json({
        error: "Invalid or already used session token",
      });
      return;
    }

    const durationMs = Number.isFinite(gameplayRecord.durationMs)
      ? Math.max(0, Math.trunc(gameplayRecord.durationMs ?? 0))
      : Date.now() - session.startTime;

    if (!session.persistentScoreEligible || session.identityKind !== "github" || !session.githubUserId) {
      res.status(200).json({
        saved: false,
        mode: "ephemeral",
        nickname: nickname.trim(),
        difficulty: session.difficulty,
        score,
        grade,
        commandCount,
        durationMs,
        scenarioTitle: session.scenarioTitle,
        timestamp: Date.now(),
      });
      return;
    }

    const entry: LeaderboardEntry = {
      id: crypto.randomUUID(),
      nickname: nickname.trim(),
      difficulty: session.difficulty,
      score,
      grade,
      commandCount,
      durationMs,
      scenarioTitle: session.scenarioTitle,
      identityKind: "github",
      githubUserId: session.githubUserId,
      githubLogin: session.githubLogin ?? undefined,
      trafficSource: session.trafficSource,
      timestamp: Date.now(),
    };

    const saved = await getLeaderboardStore().addEntry(entry);
    res.status(201).json({
      ...saved,
      saved: true,
      mode: "persistent",
    });
  } catch (error) {
    captureBackendRouteError(req, error);
    res.status(500).json({ error: "Failed to save score" });
  }
});
