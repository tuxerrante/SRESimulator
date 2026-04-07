"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useGameStore } from "@/stores/gameStore";
import { PhaseTracker } from "@/components/scoring/PhaseTracker";
import { Shield, ArrowLeft, ChevronDown, Target, FileText, Crosshair, HelpCircle, User } from "lucide-react";
import { Github } from "@/components/icons/Github";
import Link from "next/link";

interface ScorePopup {
  id: number;
  text: string;
  positive: boolean;
}

const DIMENSIONS = [
  { key: "efficiency" as const, label: "Efficiency", icon: Target, color: "text-blue-400" },
  { key: "safety" as const, label: "Safety", icon: Shield, color: "text-emerald-400" },
  { key: "documentation" as const, label: "Documentation", icon: FileText, color: "text-purple-400" },
  { key: "accuracy" as const, label: "Accuracy", icon: Crosshair, color: "text-amber-400" },
];

interface HeaderProps {
  onTourRestart?: () => void;
}

export function Header({ onTourRestart }: HeaderProps) {
  const scenario = useGameStore((s) => s.scenario);
  const nickname = useGameStore((s) => s.nickname);
  const score = useGameStore((s) => s.score);
  const status = useGameStore((s) => s.status);
  const commandCount = useGameStore((s) => s.commandCount);
  const scoringEvents = useGameStore((s) => s.scoringEvents);
  const [showScore, setShowScore] = useState(false);
  const [scorePopups, setScorePopups] = useState<ScorePopup[]>([]);
  const prevEventsLength = useRef(scoringEvents.length);
  const popupIdRef = useRef(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const addPopup = useCallback((text: string, positive: boolean) => {
    const id = ++popupIdRef.current;
    setScorePopups((prev) => [...prev, { id, text, positive }]);
    setTimeout(() => {
      setScorePopups((prev) => prev.filter((p) => p.id !== id));
    }, 1500);
  }, []);

  useEffect(() => {
    if (scoringEvents.length > prevEventsLength.current) {
      const newEvents = scoringEvents.slice(prevEventsLength.current);
      for (const event of newEvents) {
        const sign = event.type === "bonus" ? "+" : "-";
        addPopup(`${sign}${event.points}`, event.type === "bonus");
      }
    }
    prevEventsLength.current = scoringEvents.length;
  }, [scoringEvents, addPopup]);

  const scoreOpen = showScore && status === "playing";

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowScore(false);
      }
    }
    if (scoreOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [scoreOpen]);

  return (
    <header className="relative z-20 flex items-center gap-4 border-b border-zinc-700 bg-zinc-900 px-4 py-2">
      <div data-testid="header-left-cluster" className="flex min-w-0 flex-1 items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <ArrowLeft size={16} />
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <Shield size={18} className="text-amber-500" />
          <span className="font-bold text-sm text-zinc-200">
            SRE Simulator
          </span>
        </div>
        {scenario && (
          <>
            <div className="h-5 w-px shrink-0 bg-zinc-700" />
            <span
              data-testid="header-scenario-title"
              className="min-w-0 max-w-[22rem] truncate text-sm text-zinc-400"
            >
              {scenario.title}
            </span>
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium",
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

      <div data-testid="header-right-cluster" className="flex shrink-0 items-center gap-4 pl-2">
        {status === "playing" && (
          <>
            <PhaseTracker />
            {onTourRestart && (
              <>
                <div className="w-px h-5 bg-zinc-700" />
                <button
                  onClick={onTourRestart}
                  className="flex items-center justify-center w-7 h-7 rounded-lg text-zinc-500 hover:text-amber-400 hover:bg-zinc-800 transition-colors"
                  aria-label="Show UI tour"
                  title="Show UI tour"
                >
                  <HelpCircle size={16} />
                </button>
              </>
            )}
            <div className="w-px h-5 bg-zinc-700" />
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowScore(!showScore)}
                data-testid="score-toggle"
                aria-haspopup="dialog"
                aria-expanded={scoreOpen}
                aria-controls={scoreOpen ? "score-dropdown-panel" : undefined}
                className="flex items-center gap-1.5 text-sm font-mono px-2 py-1 rounded hover:bg-zinc-800 transition-colors"
              >
                <span className="text-zinc-500">Score:</span>
                <span className="text-amber-400 font-bold">{score.total}</span>
                <span className="text-zinc-600">/100</span>
                <ChevronDown
                  size={14}
                  className={cn(
                    "text-zinc-500 transition-transform",
                    scoreOpen && "rotate-180"
                  )}
                />
              </button>

              {scorePopups.map((popup, i) => (
                <span
                  key={popup.id}
                  className={cn(
                    "absolute top-full mt-1 right-0 text-xs font-bold font-mono pointer-events-none animate-score-pop whitespace-nowrap",
                    popup.positive ? "text-emerald-400" : "text-red-400"
                  )}
                  style={{ right: `${i * 28}px` }}
                >
                  {popup.text}
                </span>
              ))}

              {scoreOpen && (
                <div
                  id="score-dropdown-panel"
                  className="absolute right-0 top-full mt-2 bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-xl min-w-[240px]"
                >
                  {nickname && (
                    <div
                      data-testid="score-panel-nickname"
                      className="mb-2 flex min-w-0 items-center gap-1.5 rounded bg-zinc-800/70 px-2 py-1"
                    >
                      <User size={12} className="shrink-0 text-zinc-500" />
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">
                        Operator
                      </span>
                      <span className="min-w-0 truncate text-xs text-zinc-200">{nickname}</span>
                    </div>
                  )}
                  <div className="text-xs font-semibold text-zinc-400 mb-2 flex items-center justify-between">
                    <span>SCORE BREAKDOWN</span>
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
                  {scoringEvents.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-zinc-700">
                      <div className="text-[10px] font-semibold text-zinc-500 uppercase mb-1">
                        Recent Events
                      </div>
                      <div className="space-y-0.5 max-h-32 overflow-y-auto">
                        {scoringEvents.slice(-8).reverse().map((event, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-[11px]">
                            <span
                              className={cn(
                                "font-mono font-bold",
                                event.type === "bonus" ? "text-emerald-400" : "text-red-400"
                              )}
                            >
                              {event.type === "bonus" ? "+" : "-"}{event.points}
                            </span>
                            <span className="text-zinc-400 truncate">{event.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="w-px h-5 bg-zinc-700" />
          </>
        )}
        <a
          href="https://github.com/tuxerrante"
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-600 hover:text-zinc-300 transition-colors p-2 rounded hover:bg-zinc-800"
          title="tuxerrante on GitHub"
          aria-label="Visit tuxerrante on GitHub"
        >
          <Github size={16} />
        </a>
      </div>
    </header>
  );
}

function cn(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
