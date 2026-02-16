"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Trophy, ArrowLeft, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Difficulty } from "@/types/game";
import type { LeaderboardEntry, HallOfFameEntry } from "@/types/leaderboard";

type Tab = "all" | Difficulty;

const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "easy", label: "Easy" },
  { value: "medium", label: "Medium" },
  { value: "hard", label: "Hard" },
];

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  easy: "bg-emerald-900/50 text-emerald-400 border-emerald-800/50",
  medium: "bg-amber-900/50 text-amber-400 border-amber-800/50",
  hard: "bg-red-900/50 text-red-400 border-red-800/50",
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function RankCell({ rank }: { rank: number }) {
  if (rank === 1)
    return <Trophy size={16} className="text-amber-400" />;
  if (rank === 2)
    return <Trophy size={16} className="text-zinc-300" />;
  if (rank === 3)
    return <Trophy size={16} className="text-orange-600" />;
  return <span className="text-zinc-500 text-sm">{rank}</span>;
}

function DifficultyScore({ value }: { value?: number }) {
  if (value === undefined) return <span className="text-zinc-700">-</span>;
  return (
    <span
      className={cn(
        "font-mono",
        value >= 90 ? "text-emerald-400" :
        value >= 70 ? "text-amber-400" :
        "text-red-400"
      )}
    >
      {value}
    </span>
  );
}

export default function LeaderboardPage() {
  const [activeTab, setActiveTab] = useState<Tab>("all");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [hallOfFame, setHallOfFame] = useState<HallOfFameEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchScores = async () => {
      setLoading(true);
      try {
        const param = activeTab === "all" ? "" : `?difficulty=${activeTab}`;
        const res = await fetch(`/api/scores${param}`);
        const data = await res.json();
        setEntries(data.entries);
        setHallOfFame(data.hallOfFame);
      } catch {
        setEntries([]);
        setHallOfFame([]);
      } finally {
        setLoading(false);
      }
    };
    fetchScores();
  }, [activeTab]);

  const isEmpty = activeTab === "all" ? hallOfFame.length === 0 : entries.length === 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <div className="flex-1 flex flex-col items-center px-6 py-12">
        <div className="w-full max-w-2xl">
          <div className="flex items-center gap-3 mb-8">
            <Link
              href="/"
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <ArrowLeft size={20} />
            </Link>
            <Trophy size={24} className="text-amber-500" />
            <h1 className="text-2xl font-bold tracking-tight">Hall of Fame</h1>
          </div>

          <div className="flex gap-1 mb-6 bg-zinc-900 rounded-lg p-1 border border-zinc-800">
            {TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={cn(
                  "flex-1 py-1.5 text-sm font-medium rounded-md transition-colors",
                  activeTab === tab.value
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16 text-zinc-500">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : isEmpty ? (
            <div className="text-center py-16 text-zinc-600 text-sm">
              No scores yet. Complete a scenario to appear here.
            </div>
          ) : activeTab === "all" ? (
            /* Aggregated Hall of Fame table */
            <div className="border border-zinc-800 rounded-xl overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase">
                    <th className="px-4 py-3 text-left w-12">Rank</th>
                    <th className="px-4 py-3 text-left">Nickname</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-center">
                      <span className="text-emerald-600">Easy</span>
                    </th>
                    <th className="px-4 py-3 text-center">
                      <span className="text-amber-600">Med</span>
                    </th>
                    <th className="px-4 py-3 text-center">
                      <span className="text-red-600">Hard</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {hallOfFame.map((entry, i) => (
                    <tr
                      key={entry.nickname}
                      className="border-b border-zinc-800/50 last:border-b-0 hover:bg-zinc-900/50"
                    >
                      <td className="px-4 py-3">
                        <RankCell rank={i + 1} />
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-zinc-200">
                        {entry.nickname}
                      </td>
                      <td className="px-4 py-3 text-sm font-mono font-bold text-zinc-200 text-right">
                        {entry.compositeScore}
                      </td>
                      <td className="px-4 py-3 text-sm text-center">
                        <DifficultyScore value={entry.scores.easy} />
                      </td>
                      <td className="px-4 py-3 text-sm text-center">
                        <DifficultyScore value={entry.scores.medium} />
                      </td>
                      <td className="px-4 py-3 text-sm text-center">
                        <DifficultyScore value={entry.scores.hard} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            /* Per-difficulty leaderboard table */
            <div className="border border-zinc-800 rounded-xl overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase">
                    <th className="px-4 py-3 text-left w-12">Rank</th>
                    <th className="px-4 py-3 text-left">Nickname</th>
                    <th className="px-4 py-3 text-right">Score</th>
                    <th className="px-4 py-3 text-center">Grade</th>
                    <th className="px-4 py-3 text-center">Difficulty</th>
                    <th className="px-4 py-3 text-right">Duration</th>
                    <th className="px-4 py-3 text-right">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, i) => (
                    <tr
                      key={entry.id}
                      className="border-b border-zinc-800/50 last:border-b-0 hover:bg-zinc-900/50"
                    >
                      <td className="px-4 py-3">
                        <RankCell rank={i + 1} />
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-zinc-200">
                        {entry.nickname}
                      </td>
                      <td className="px-4 py-3 text-sm font-mono text-zinc-300 text-right">
                        {entry.score.total}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={cn(
                            "text-sm font-bold",
                            entry.grade === "A" && "text-emerald-400",
                            entry.grade === "B" && "text-blue-400",
                            entry.grade === "C" && "text-amber-400",
                            (entry.grade === "D" || entry.grade === "F") &&
                              "text-red-400"
                          )}
                        >
                          {entry.grade}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={cn(
                            "text-xs px-2 py-0.5 rounded-full border",
                            DIFFICULTY_COLORS[entry.difficulty]
                          )}
                        >
                          {entry.difficulty}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-400 text-right font-mono">
                        {formatDuration(entry.durationMs)}
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-500 text-right">
                        {formatDate(entry.timestamp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <footer className="text-center text-zinc-700 text-xs py-4">
        ARO SRE Simulator &mdash; Investigation training powered by AI
      </footer>
    </div>
  );
}
