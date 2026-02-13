"use client";

import { useGameStore } from "@/stores/gameStore";
import { PHASE_ORDER, PHASE_LABELS, type InvestigationPhase } from "@/types/chat";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

export function PhaseTracker() {
  const currentPhase = useGameStore((s) => s.currentPhase);
  const phaseHistory = useGameStore((s) => s.phaseHistory);

  const currentIdx = PHASE_ORDER.indexOf(currentPhase);

  return (
    <div className="flex items-center gap-1">
      {PHASE_ORDER.map((phase, idx) => {
        const isActive = phase === currentPhase;
        const isCompleted = phaseHistory.includes(phase) && idx < currentIdx;

        return (
          <div key={phase} className="flex items-center">
            <div
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                isActive && "bg-amber-600/20 text-amber-400 ring-1 ring-amber-600/50",
                isCompleted && "bg-emerald-600/20 text-emerald-400",
                !isActive && !isCompleted && "bg-zinc-800 text-zinc-600"
              )}
            >
              {isCompleted && <Check size={10} />}
              {PHASE_LABELS[phase]}
            </div>
            {idx < PHASE_ORDER.length - 1 && (
              <div
                className={cn(
                  "w-4 h-px mx-0.5",
                  idx < currentIdx ? "bg-emerald-600" : "bg-zinc-700"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
