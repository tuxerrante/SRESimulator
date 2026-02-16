import { NextRequest, NextResponse } from "next/server";
import { addEntry, getLeaderboard, getHallOfFame } from "@/lib/leaderboard";
import { validateAndConsumeSession } from "@/lib/sessions";
import type { Difficulty } from "@/types/game";
import type { LeaderboardEntry } from "@/types/leaderboard";

export const runtime = "nodejs";

const VALID_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const difficulty = searchParams.get("difficulty") as Difficulty | null;

    if (difficulty && !VALID_DIFFICULTIES.includes(difficulty)) {
      return NextResponse.json(
        { error: "Invalid difficulty. Must be easy, medium, or hard." },
        { status: 400 }
      );
    }

    const entries = await getLeaderboard(difficulty ?? undefined);
    const hallOfFame = await getHallOfFame();

    return NextResponse.json({ entries, hallOfFame });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch leaderboard";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { sessionToken, nickname, score, grade, commandCount } = body;

    // Validate session token
    if (!sessionToken || typeof sessionToken !== "string") {
      return NextResponse.json({ error: "Session token is required" }, { status: 400 });
    }
    const session = validateAndConsumeSession(sessionToken);
    if (!session) {
      return NextResponse.json(
        { error: "Invalid or already used session token" },
        { status: 403 }
      );
    }

    if (!nickname || typeof nickname !== "string" || nickname.trim().length === 0) {
      return NextResponse.json({ error: "Nickname is required" }, { status: 400 });
    }
    if (nickname.length > 20) {
      return NextResponse.json({ error: "Nickname must be 20 characters or less" }, { status: 400 });
    }
    if (!score || typeof score.total !== "number") {
      return NextResponse.json({ error: "Invalid score" }, { status: 400 });
    }

    // Use server-side session data for difficulty, scenarioTitle, and duration
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
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save score";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
