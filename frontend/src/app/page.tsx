"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useGameStore } from "@/stores/gameStore";
import type { Difficulty, Scenario } from "@/types/game";
import { Shield, AlertTriangle, Zap, Flame, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

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
  const [loading, setLoading] = useState<Difficulty | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async (difficulty: Difficulty) => {
    setLoading(difficulty);
    setError(null);

    try {
      const response = await fetch("/api/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ difficulty }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to generate scenario");
      }

      const scenario: Scenario = await response.json();
      startGame(scenario);
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
        <div className="flex items-center gap-3 mb-2">
          <Shield size={36} className="text-amber-500" />
          <h1 className="text-3xl font-bold tracking-tight">SRE Simulator</h1>
        </div>
        <p className="text-zinc-500 text-center mb-2 max-w-lg">
          The Break-Fix Game for Azure Red Hat OpenShift
        </p>
        <p className="text-zinc-600 text-sm text-center mb-12 max-w-md">
          An AI Dungeon Master will break a cluster. Your job is to investigate
          and fix it using the proper SRE methodology.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-3xl">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.level}
              onClick={() => handleSelect(d.level)}
              disabled={loading !== null}
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

        {error && (
          <div className="mt-6 px-4 py-2 rounded-lg bg-red-950/50 border border-red-800/50 text-red-400 text-sm max-w-md text-center">
            {error}
          </div>
        )}
      </div>

      <footer className="text-center text-zinc-700 text-xs py-4">
        ARO SRE Simulator &mdash; Investigation training powered by AI
      </footer>
    </div>
  );
}
