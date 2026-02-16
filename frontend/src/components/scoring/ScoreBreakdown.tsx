"use client";

import { useState } from "react";
import { useGameStore } from "@/stores/gameStore";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Trophy, Target, Shield, FileText, Crosshair, X, Check, Loader2 } from "lucide-react";

const DIMENSIONS = [
  { key: "efficiency" as const, label: "Efficiency", icon: Target, color: "blue", description: "Number of commands vs optimal path" },
  { key: "safety" as const, label: "Safety", icon: Shield, color: "emerald", description: "Checked dashboards before actions, backed up configs" },
  { key: "documentation" as const, label: "Documentation", icon: FileText, color: "purple", description: "Followed methodology phases in order" },
  { key: "accuracy" as const, label: "Accuracy", icon: Crosshair, color: "amber", description: "Correctly identified root cause" },
];

export function ScoreBreakdown() {
  const router = useRouter();
  const score = useGameStore((s) => s.score);
  const scoringEvents = useGameStore((s) => s.scoringEvents);
  const scenario = useGameStore((s) => s.scenario);
  const commandCount = useGameStore((s) => s.commandCount);
  const sessionToken = useGameStore((s) => s.sessionToken);
  const resetGame = useGameStore((s) => s.resetGame);

  const [nickname, setNickname] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "submitted">("idle");

  const handleClose = () => {
    resetGame();
    router.push("/");
  };

  const grade =
    score.total >= 90 ? "A" :
    score.total >= 80 ? "B" :
    score.total >= 70 ? "C" :
    score.total >= 60 ? "D" : "F";

  const handleSubmit = async () => {
    if (!nickname.trim() || submitState !== "idle") return;
    setSubmitState("submitting");
    try {
      await fetch("/api/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionToken,
          nickname: nickname.trim(),
          score,
          grade,
          commandCount,
        }),
      });
      setSubmitState("submitted");
    } catch {
      setSubmitState("idle");
    }
  };

  const gradeColor =
    grade === "A" ? "text-emerald-400" :
    grade === "B" ? "text-blue-400" :
    grade === "C" ? "text-amber-400" :
    "text-red-400";

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700">
          <div className="flex items-center gap-2">
            <Trophy size={20} className="text-amber-500" />
            <h2 className="font-bold text-zinc-200">Investigation Complete</h2>
          </div>
          <button
            onClick={handleClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4">
          {scenario && (
            <div className="text-sm text-zinc-400 mb-4">
              Scenario: <span className="text-zinc-200">{scenario.title}</span>
            </div>
          )}

          <div className="flex items-center justify-center gap-4 mb-6">
            <div className={cn("text-6xl font-bold", gradeColor)}>{grade}</div>
            <div>
              <div className="text-2xl font-bold text-zinc-200">
                {score.total}/100
              </div>
              <div className="text-xs text-zinc-500">
                {commandCount} commands executed
              </div>
            </div>
          </div>

          <div className="space-y-4 mb-6">
            {DIMENSIONS.map((d) => {
              const Icon = d.icon;
              const value = score[d.key];
              return (
                <div key={d.key}>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon
                      size={14}
                      className={cn(
                        d.color === "blue" && "text-blue-400",
                        d.color === "emerald" && "text-emerald-400",
                        d.color === "purple" && "text-purple-400",
                        d.color === "amber" && "text-amber-400"
                      )}
                    />
                    <span className="text-sm font-medium text-zinc-300">
                      {d.label}
                    </span>
                    <span className="text-sm font-mono text-zinc-400 ml-auto">
                      {value}/25
                    </span>
                  </div>
                  <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-1">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        value >= 20 ? "bg-emerald-500" :
                        value >= 10 ? "bg-amber-500" : "bg-red-500"
                      )}
                      style={{ width: `${(value / 25) * 100}%` }}
                    />
                  </div>
                  <div className="text-xs text-zinc-600">{d.description}</div>
                </div>
              );
            })}
          </div>

          {scoringEvents.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-zinc-500 mb-2 uppercase">
                Scoring Events
              </h3>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {scoringEvents.map((event, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span
                      className={cn(
                        "font-mono",
                        event.type === "bonus"
                          ? "text-emerald-400"
                          : "text-red-400"
                      )}
                    >
                      {event.type === "bonus" ? "+" : "-"}{event.points}
                    </span>
                    <span className="text-zinc-500">{event.dimension}</span>
                    <span className="text-zinc-400">{event.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-zinc-700 space-y-3">
          {submitState !== "submitted" ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value.slice(0, 20))}
                placeholder="Your callsign"
                maxLength={20}
                disabled={submitState === "submitting"}
                className="flex-1 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-600 disabled:opacity-50"
              />
              <button
                onClick={handleSubmit}
                disabled={!nickname.trim() || submitState === "submitting"}
                className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {submitState === "submitting" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : null}
                Submit to Leaderboard
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-emerald-400 text-sm justify-center py-2">
              <Check size={16} />
              Submitted!
            </div>
          )}
          <button
            onClick={handleClose}
            className="w-full py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-sm font-medium hover:bg-zinc-700 transition-colors"
          >
            Back to Scenarios
          </button>
        </div>
      </div>
    </div>
  );
}
