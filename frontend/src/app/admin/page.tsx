"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, ArrowLeft, Loader2 } from "lucide-react";
import { cn, formatShortDateTime } from "@/lib/utils";
import type {
  GameplayAnalytics,
  GameplayDifficultyAnalytics,
  GameplayScenarioAnalytics,
  RecentGameplaySession,
} from "@shared/types/gameplay";
import type { Difficulty } from "@shared/types/game";

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  easy: "bg-emerald-900/50 text-emerald-400 border-emerald-800/50",
  medium: "bg-amber-900/50 text-amber-400 border-amber-800/50",
  hard: "bg-red-900/50 text-red-400 border-red-800/50",
};

function formatRate(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatMaybeNumber(value: number | null | undefined): string {
  if (value == null) return "-";
  return `${Math.round(value * 100) / 100}`;
}

function formatDuration(value: number | null | undefined): string {
  if (value == null) return "-";
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function SummaryCard({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-zinc-100">{value}</div>
      {helper ? <div className="mt-1 text-xs text-zinc-500">{helper}</div> : null}
    </div>
  );
}

function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs font-medium",
        DIFFICULTY_COLORS[difficulty],
      )}
    >
      {difficulty}
    </span>
  );
}

export default function AdminAnalyticsPage() {
  const [analytics, setAnalytics] = useState<GameplayAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAnalytics = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/gameplay/admin");
        const raw = await response.text();
        const parsed = JSON.parse(raw) as GameplayAnalytics | { error?: string };
        if (!response.ok) {
          throw new Error("error" in parsed ? parsed.error : "Failed to load gameplay analytics");
        }
        setAnalytics(parsed as GameplayAnalytics);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load gameplay analytics");
      } finally {
        setLoading(false);
      }
    };

    void fetchAnalytics();
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-zinc-500 transition-colors hover:text-zinc-200"
          >
            <ArrowLeft size={20} />
          </Link>
          <Activity size={22} className="text-amber-500" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Admin Analytics</h1>
            <p className="text-sm text-zinc-500">
              Gameplay lifecycle telemetry across started, completed, and abandoned sessions.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-zinc-500">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        ) : analytics ? (
          <>
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <SummaryCard
                label="Total Sessions"
                value={String(analytics.summary.totalSessions)}
                helper={`${analytics.summary.inProgressSessions} currently in progress`}
              />
              <SummaryCard
                label="Completion Rate"
                value={formatRate(analytics.summary.completionRate)}
                helper={`${analytics.summary.completedSessions} completed sessions`}
              />
              <SummaryCard
                label="Abandonment Rate"
                value={formatRate(analytics.summary.abandonmentRate)}
                helper={`${analytics.summary.abandonedSessions} abandoned sessions`}
              />
              <SummaryCard
                label="Avg Completed Score"
                value={formatMaybeNumber(analytics.summary.avgCompletionScoreTotal)}
                helper={`Avg duration ${formatDuration(analytics.summary.avgCompletionDurationMs)}`}
              />
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.15fr_1fr]">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
                <h2 className="mb-4 text-sm font-semibold text-zinc-100">
                  Difficulty Breakdown
                </h2>
                <div className="space-y-3">
                  {analytics.byDifficulty.map((bucket: GameplayDifficultyAnalytics) => (
                    <div
                      key={bucket.difficulty}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
                    >
                      <div className="flex items-center justify-between">
                        <DifficultyBadge difficulty={bucket.difficulty} />
                        <span className="text-sm font-mono text-zinc-400">
                          {formatRate(bucket.completionRate)}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                        <div>
                          <div className="text-zinc-500">Total</div>
                          <div className="font-medium text-zinc-200">{bucket.totalSessions}</div>
                        </div>
                        <div>
                          <div className="text-zinc-500">Completed</div>
                          <div className="font-medium text-emerald-400">{bucket.completedSessions}</div>
                        </div>
                        <div>
                          <div className="text-zinc-500">Abandoned</div>
                          <div className="font-medium text-red-400">{bucket.abandonedSessions}</div>
                        </div>
                        <div>
                          <div className="text-zinc-500">In Progress</div>
                          <div className="font-medium text-amber-400">{bucket.inProgressSessions}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
                <h2 className="mb-4 text-sm font-semibold text-zinc-100">
                  Top Scenarios
                </h2>
                <div className="space-y-3">
                  {analytics.byScenario.map((bucket: GameplayScenarioAnalytics) => (
                    <div
                      key={`${bucket.difficulty ?? "unknown"}-${bucket.scenarioTitle}`}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-zinc-200">
                            {bucket.scenarioTitle}
                          </div>
                          {bucket.difficulty ? (
                            <div className="mt-2">
                              <DifficultyBadge difficulty={bucket.difficulty} />
                            </div>
                          ) : null}
                        </div>
                        <div className="text-right text-sm font-mono text-zinc-400">
                          {formatRate(bucket.completionRate)}
                        </div>
                      </div>
                      <div className="mt-3 flex gap-4 text-xs text-zinc-500">
                        <span>Total {bucket.totalSessions}</span>
                        <span>Completed {bucket.completedSessions}</span>
                        <span>Abandoned {bucket.abandonedSessions}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
              <h2 className="mb-4 text-sm font-semibold text-zinc-100">
                Recent Sessions
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr className="border-b border-zinc-800 text-left text-xs uppercase text-zinc-500">
                      <th className="px-3 py-2">When</th>
                      <th className="px-3 py-2">State</th>
                      <th className="px-3 py-2">Scenario</th>
                      <th className="px-3 py-2">Callsign</th>
                      <th className="px-3 py-2 text-right">Score</th>
                      <th className="px-3 py-2 text-right">Commands</th>
                      <th className="px-3 py-2 text-right">Chat</th>
                      <th className="px-3 py-2 text-right">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.recentSessions.map((session: RecentGameplaySession) => (
                      <tr
                        key={`${session.sessionToken ?? session.createdAt}-${session.lifecycleState}`}
                        className="border-b border-zinc-800/50 text-sm last:border-b-0"
                      >
                        <td className="px-3 py-3 text-zinc-400">
                          {formatShortDateTime(session.createdAt)}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-xs font-medium",
                              session.lifecycleState === "completed" &&
                                "bg-emerald-950/50 text-emerald-400",
                              session.lifecycleState === "abandoned" &&
                                "bg-red-950/50 text-red-400",
                              session.lifecycleState === "started" &&
                                "bg-amber-950/50 text-amber-400",
                            )}
                          >
                            {session.lifecycleState}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium text-zinc-200">
                            {session.scenarioTitle ?? "Unknown scenario"}
                          </div>
                          {session.difficulty ? (
                            <div className="mt-2">
                              <DifficultyBadge difficulty={session.difficulty} />
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-zinc-400">
                          {session.nickname ?? "-"}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-zinc-300">
                          {session.scoreTotal ?? "-"}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-zinc-400">
                          {session.commandCount ?? "-"}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-zinc-400">
                          {session.chatMessageCount ?? "-"}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-zinc-400">
                          {formatDuration(session.durationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
