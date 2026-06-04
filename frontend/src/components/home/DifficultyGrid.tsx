import type { Difficulty } from "@shared/types/game";
import { canAccessDifficulty } from "@shared/auth/access";
import type { Viewer } from "@shared/auth/viewer";
import { AlertTriangle, Flame, Loader2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const DIFFICULTIES: {
  level: Difficulty;
  title: string;
  subtitle: string;
  description: string;
  lockedDescription?: string;
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
    lockedDescription: "GitHub login required",
    icon: <Zap size={24} />,
    color: "amber",
  },
  {
    level: "hard",
    title: "The Principal Engineer",
    subtitle: "Hard",
    description:
      "Deep obscure bugs, race conditions, and distributed system failures. Only for the experienced.",
    lockedDescription: "GitHub login required",
    icon: <Flame size={24} />,
    color: "red",
  },
];

interface DifficultyGridProps {
  viewer: Viewer;
  hasCallsign: boolean;
  loadingDifficulty: Difficulty | null;
  onSelect: (difficulty: Difficulty) => void;
}

export function DifficultyGrid({
  viewer,
  hasCallsign,
  loadingDifficulty,
  onSelect,
}: DifficultyGridProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-3xl">
      {DIFFICULTIES.map((difficulty) => {
        const allowed = canAccessDifficulty(viewer, difficulty.level);
        const disabled = loadingDifficulty !== null || !hasCallsign || !allowed;

        return (
          <button
            key={difficulty.level}
            onClick={() => onSelect(difficulty.level)}
            disabled={disabled}
            className={cn(
              "flex flex-col items-start p-5 rounded-xl border transition-all text-left",
              "hover:scale-[1.02] active:scale-[0.98]",
              "disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100",
              difficulty.color === "emerald" &&
                "border-emerald-800/50 bg-emerald-950/30 hover:border-emerald-600/50 hover:bg-emerald-950/50",
              difficulty.color === "amber" &&
                "border-amber-800/50 bg-amber-950/30 hover:border-amber-600/50 hover:bg-amber-950/50",
              difficulty.color === "red" &&
                "border-red-800/50 bg-red-950/30 hover:border-red-600/50 hover:bg-red-950/50"
            )}
          >
            <div
              className={cn(
                "mb-3",
                difficulty.color === "emerald" && "text-emerald-400",
                difficulty.color === "amber" && "text-amber-400",
                difficulty.color === "red" && "text-red-400"
              )}
            >
              {loadingDifficulty === difficulty.level ? (
                <Loader2 size={24} className="animate-spin" />
              ) : (
                difficulty.icon
              )}
            </div>
            <div className="text-sm font-bold text-zinc-200 mb-0.5">
              {difficulty.title}
            </div>
            <div
              className={cn(
                "text-xs font-semibold mb-2",
                difficulty.color === "emerald" && "text-emerald-400",
                difficulty.color === "amber" && "text-amber-400",
                difficulty.color === "red" && "text-red-400"
              )}
            >
              {difficulty.subtitle}
            </div>
            <div className="text-xs text-zinc-500 leading-relaxed">
              {allowed ? difficulty.description : difficulty.lockedDescription}
            </div>
          </button>
        );
      })}
    </div>
  );
}
