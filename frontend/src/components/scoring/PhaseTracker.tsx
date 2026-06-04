"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useGameStore } from "@/stores/gameStore";
import { PHASE_ORDER, PHASE_LABELS } from "@shared/types/chat";
import { cn } from "@/lib/utils";
import { Check, ChevronDown } from "lucide-react";

export function PhaseTracker() {
  const currentPhase = useGameStore((s) => s.currentPhase);
  const phaseHistory = useGameStore((s) => s.phaseHistory);
  const [isOpen, setIsOpen] = useState(false);
  const trackerRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const currentIdx = PHASE_ORDER.indexOf(currentPhase);
  const currentLabel = PHASE_LABELS[currentPhase];

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    function handleClickOutside(e: MouseEvent) {
      const tracker = trackerRef.current;
      const target = e.target;
      if (!tracker || !(target instanceof Node)) {
        return;
      }
      if (!tracker.contains(target)) {
        setIsOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  return (
    <div ref={trackerRef} data-testid="phase-tracker" className="relative shrink-0">
      <button
        type="button"
        data-testid="phase-tracker-button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        className="flex max-w-32 items-center gap-1 rounded bg-amber-600/20 px-2 py-0.5 text-xs font-medium text-amber-400 ring-1 ring-amber-600/50"
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown
          size={12}
          className={cn("shrink-0 transition-transform", isOpen && "rotate-180")}
        />
      </button>
      {isOpen && (
        <ul
          id={menuId}
          aria-label="Investigation phases"
          data-testid="phase-tracker-menu"
          className="absolute right-0 top-full z-30 mt-2 min-w-[13rem] rounded-md border border-zinc-700 bg-zinc-900 p-1.5 shadow-xl"
        >
          {PHASE_ORDER.map((phase, idx) => {
            const isActive = phase === currentPhase;
            const isCompleted = phaseHistory.includes(phase) && idx < currentIdx;

            return (
              <li
                key={phase}
                className={cn(
                  "mb-0.5 flex items-center justify-between gap-3 rounded px-2 py-1 text-xs",
                  isActive && "bg-amber-600/20 text-amber-300",
                  isCompleted && "bg-emerald-600/20 text-emerald-300",
                  !isActive && !isCompleted && "text-zinc-500"
                )}
              >
                <span>{PHASE_LABELS[phase]}</span>
                <span className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide">
                  {isCompleted ? (
                    <>
                      <Check size={10} />
                      Done
                    </>
                  ) : isActive ? (
                    "Current"
                  ) : (
                    "Pending"
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
