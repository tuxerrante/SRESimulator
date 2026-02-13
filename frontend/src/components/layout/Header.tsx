"use client";

import { useGameStore } from "@/stores/gameStore";
import { PhaseTracker } from "@/components/scoring/PhaseTracker";
import { Shield, ArrowLeft } from "lucide-react";
import Link from "next/link";

export function Header() {
  const scenario = useGameStore((s) => s.scenario);
  const score = useGameStore((s) => s.score);
  const status = useGameStore((s) => s.status);

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-700 bg-zinc-900">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <ArrowLeft size={16} />
        </Link>
        <div className="flex items-center gap-2">
          <Shield size={18} className="text-amber-500" />
          <span className="font-bold text-sm text-zinc-200">
            SRE Simulator
          </span>
        </div>
        {scenario && (
          <>
            <div className="w-px h-5 bg-zinc-700" />
            <span className="text-sm text-zinc-400">{scenario.title}</span>
            <span
              className={cn(
                "text-xs px-1.5 py-0.5 rounded font-medium",
                scenario.difficulty === "easy" && "bg-emerald-600/20 text-emerald-400",
                scenario.difficulty === "medium" && "bg-amber-600/20 text-amber-400",
                scenario.difficulty === "hard" && "bg-red-600/20 text-red-400"
              )}
            >
              {scenario.difficulty}
            </span>
          </>
        )}
      </div>

      {status === "playing" && (
        <div className="flex items-center gap-4">
          <PhaseTracker />
          <div className="w-px h-5 bg-zinc-700" />
          <div className="text-sm font-mono">
            <span className="text-zinc-500">Score: </span>
            <span className="text-amber-400 font-bold">{score.total}</span>
            <span className="text-zinc-600">/100</span>
          </div>
        </div>
      )}
    </header>
  );
}

function cn(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
