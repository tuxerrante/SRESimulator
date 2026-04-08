"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useGameStore } from "@/stores/gameStore";
import type { Difficulty, Scenario } from "@shared/types/game";
import { Shield, AlertTriangle, Zap, Flame, Loader2, Trophy, Heart, User } from "lucide-react";
import { Github } from "@/components/icons/Github";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { APP_VERSION, HOME_FEATURE_HIGHLIGHTS } from "@/lib/release";

const DIFFICULTIES: {
  level: Difficulty;
  title: string;
  subtitle: string;
  description: string;
  icon: React.ReactNode;
  color: string;
}[] = [
  {
    level: "easy",
    title: "The Junior SRE",
    subtitle: "Easy",
    description:
      "Single-component failures with obvious symptoms. Perfect for learning the investigation methodology.",
    icon: <AlertTriangle size={24} />,
    color: "emerald",
  },
  {
    level: "medium",
    title: "The Shift Lead",
    subtitle: "Medium",
    description:
      "Networking, permissions, and configuration drift. Requires deeper investigation across multiple components.",
    icon: <Zap size={24} />,
    color: "amber",
  },
  {
    level: "hard",
    title: "The Principal Engineer",
    subtitle: "Hard",
    description:
      "Deep obscure bugs, race conditions, and distributed system failures. Only for the experienced.",
    icon: <Flame size={24} />,
    color: "red",
  },
];

export default function HomePage() {
  const router = useRouter();
  const startGame = useGameStore((s) => s.startGame);
  const nickname = useGameStore((s) => s.nickname);
  const setNickname = useGameStore((s) => s.setNickname);
  const hydrateNickname = useGameStore((s) => s.hydrateNickname);
  const [loading, setLoading] = useState<Difficulty | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const hasCallsign = Boolean(nickname);

  useEffect(() => { hydrateNickname(); }, [hydrateNickname]);

  const handleSelect = async (difficulty: Difficulty) => {
    setLoading(difficulty);
    setError(null);

    try {
      const response = await fetch("/api/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ difficulty }),
      });

      const raw = await response.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Server error (${response.status}): ${raw.slice(0, 120)}`);
      }

      if (!response.ok) {
        throw new Error((parsed.error as string) || "Failed to generate scenario");
      }

      const { scenario, sessionToken } = parsed as unknown as { scenario: Scenario; sessionToken: string };
      startGame(scenario, sessionToken);
      router.push("/game");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="mb-4 inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
          AI-guided incident response training
        </div>
        <div className="flex items-center gap-3 mb-2">
          <Shield size={36} className="text-amber-500" />
          <h1 className="text-4xl font-bold tracking-tight text-zinc-100">SRE Simulator</h1>
        </div>
        <p className="text-zinc-200 text-center mb-2 max-w-xl text-lg">
          Learn to investigate outages before they hit production.
        </p>
        <p className="text-zinc-300 text-sm text-center mb-10 max-w-lg leading-relaxed">
          An AI Dungeon Master will break a cluster. Your job is to investigate
          and fix it using the proper SRE methodology for Azure Red Hat
          OpenShift.
        </p>

        <div className="flex items-center gap-2 mb-8 w-full max-w-xs">
          <User size={18} className="text-zinc-500 shrink-0" />
          <input
            type="text"
            value={nickname ?? ""}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Enter your callsign"
            aria-label="Callsign"
            maxLength={20}
            className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-600 transition-colors"
          />
        </div>
        {!hasCallsign && (
          <p className="mb-8 -mt-5 text-xs text-zinc-400">
            Enter a callsign to unlock scenarios.
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-3xl">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.level}
              onClick={() => handleSelect(d.level)}
              disabled={loading !== null || !hasCallsign}
              className={cn(
                "flex flex-col items-start p-5 rounded-xl border transition-all text-left",
                "hover:scale-[1.02] active:scale-[0.98]",
                "disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100",
                d.color === "emerald" &&
                  "border-emerald-800/50 bg-emerald-950/30 hover:border-emerald-600/50 hover:bg-emerald-950/50",
                d.color === "amber" &&
                  "border-amber-800/50 bg-amber-950/30 hover:border-amber-600/50 hover:bg-amber-950/50",
                d.color === "red" &&
                  "border-red-800/50 bg-red-950/30 hover:border-red-600/50 hover:bg-red-950/50"
              )}
            >
              <div
                className={cn(
                  "mb-3",
                  d.color === "emerald" && "text-emerald-400",
                  d.color === "amber" && "text-amber-400",
                  d.color === "red" && "text-red-400"
                )}
              >
                {loading === d.level ? (
                  <Loader2 size={24} className="animate-spin" />
                ) : (
                  d.icon
                )}
              </div>
              <div className="text-sm font-bold text-zinc-200 mb-0.5">
                {d.title}
              </div>
              <div
                className={cn(
                  "text-xs font-semibold mb-2",
                  d.color === "emerald" && "text-emerald-400",
                  d.color === "amber" && "text-amber-400",
                  d.color === "red" && "text-red-400"
                )}
              >
                {d.subtitle}
              </div>
              <div className="text-xs text-zinc-500 leading-relaxed">
                {d.description}
              </div>
            </button>
          ))}
        </div>

        <Link
          href="/leaderboard"
          className="mt-8 flex items-center gap-2 text-zinc-500 hover:text-amber-400 transition-colors text-sm"
        >
          <Trophy size={16} />
          Hall of Fame
        </Link>

        {loading && (
          <div className="mt-6 flex items-center gap-2 text-zinc-500 text-sm">
            <Loader2 size={14} className="animate-spin" />
            Generating scenario...
          </div>
        )}

        {error && (
          <div className="mt-6 px-4 py-2 rounded-lg bg-red-950/50 border border-red-800/50 text-red-400 text-sm max-w-md text-center">
            {error}
          </div>
        )}
      </div>

      <footer className="flex flex-col items-center gap-4 py-6 px-6">
        <a
          href="https://github.com/tuxerrante"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "group flex items-center gap-3 px-5 py-3 rounded-xl border transition-all",
            "border-zinc-800 bg-zinc-900/60 hover:border-amber-700/50 hover:bg-zinc-900"
          )}
        >
          <Github size={20} className="text-zinc-400 group-hover:text-zinc-200 transition-colors" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-zinc-300 group-hover:text-zinc-100 transition-colors">
              tuxerrante
            </span>
            <span className="text-[11px] text-zinc-600 group-hover:text-zinc-500 transition-colors flex items-center gap-1">
              Built with <Heart size={10} className="text-red-500/70" /> by Alessandro Affinito
            </span>
          </div>
        </a>

        <div className="text-zinc-500 text-xs text-center">
          ARO SRE Simulator &mdash; Investigation training powered by AI
          <span className="mx-2">&middot;</span>
          <button
            type="button"
            onClick={() => setShowReleaseNotes((prev) => !prev)}
            className="underline decoration-zinc-600 underline-offset-2 hover:text-zinc-200 hover:decoration-zinc-300 transition-colors"
            aria-expanded={showReleaseNotes}
            aria-controls="release-notes-panel"
            aria-label={`${showReleaseNotes ? "Hide" : "Show"} release notes (${APP_VERSION})`}
          >
            {APP_VERSION}
          </button>
          <span className="mx-2">&middot;</span>
          <Link href="/about" className="hover:text-zinc-200 transition-colors">
            About
          </Link>
        </div>
        <section
          id="release-notes-panel"
          hidden={!showReleaseNotes}
          aria-hidden={!showReleaseNotes}
          className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 text-left"
        >
          <h2 className="mb-2 text-sm font-semibold text-zinc-100">
            Main feature updates
          </h2>
          <ul className="space-y-1 text-sm text-zinc-300">
            {HOME_FEATURE_HIGHLIGHTS.map((feature) => (
              <li key={feature} className="leading-relaxed">
                - {feature}
              </li>
            ))}
          </ul>
        </section>
      </footer>
    </div>
  );
}
