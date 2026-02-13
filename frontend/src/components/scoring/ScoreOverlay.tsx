"use client";

import { useGameStore } from "@/stores/gameStore";
import { cn } from "@/lib/utils";
import { Target, Shield, FileText, Crosshair } from "lucide-react";

const DIMENSIONS = [
  { key: "efficiency" as const, label: "Efficiency", icon: Target, color: "text-blue-400" },
  { key: "safety" as const, label: "Safety", icon: Shield, color: "text-emerald-400" },
  { key: "documentation" as const, label: "Documentation", icon: FileText, color: "text-purple-400" },
  { key: "accuracy" as const, label: "Accuracy", icon: Crosshair, color: "text-amber-400" },
];

export function ScoreOverlay() {
  const score = useGameStore((s) => s.score);
  const commandCount = useGameStore((s) => s.commandCount);

  return (
    <div className="fixed bottom-4 right-4 bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-xl min-w-[180px]">
      <div className="text-xs font-semibold text-zinc-400 mb-2 flex items-center justify-between">
        <span>SCORE</span>
        <span className="text-zinc-600">{commandCount} cmds</span>
      </div>
      <div className="space-y-1.5">
        {DIMENSIONS.map((d) => {
          const Icon = d.icon;
          const value = score[d.key];
          return (
            <div key={d.key} className="flex items-center gap-2">
              <Icon size={12} className={d.color} />
              <span className="text-xs text-zinc-500 w-20">{d.label}</span>
              <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    value >= 20 ? "bg-emerald-500" :
                    value >= 10 ? "bg-amber-500" : "bg-red-500"
                  )}
                  style={{ width: `${(value / 25) * 100}%` }}
                />
              </div>
              <span className="text-xs text-zinc-400 font-mono w-6 text-right">
                {value}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 pt-2 border-t border-zinc-700 flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-300">Total</span>
        <span className="text-sm font-bold text-amber-400">{score.total}/100</span>
      </div>
    </div>
  );
}
