"use client";

import { useCallback } from "react";
import { useGameStore } from "@/stores/gameStore";
import type { InvestigationPhase } from "@shared/types/chat";

export function useScoring() {
  const {
    currentPhase,
    checkedDashboard,
    commandCount,
    addScoringEvent,
    recalculateScore,
    setCheckedDashboard,
  } = useGameStore();

  const checkDashboardAccess = useCallback(() => {
    if (!checkedDashboard) {
      setCheckedDashboard(true);
      addScoringEvent({
        type: "bonus",
        dimension: "safety",
        points: 5,
        reason: "Checked dashboard before running commands",
        timestamp: Date.now(),
      });
      recalculateScore();
    }
  }, [checkedDashboard, setCheckedDashboard, addScoringEvent, recalculateScore]);

  const penalizePhaseSkip = useCallback(
    (attemptedPhase: InvestigationPhase) => {
      const phaseOrder: InvestigationPhase[] = [
        "reading",
        "context",
        "facts",
        "theory",
        "action",
      ];
      const currentIdx = phaseOrder.indexOf(currentPhase);
      const attemptedIdx = phaseOrder.indexOf(attemptedPhase);

      if (attemptedIdx > currentIdx + 1) {
        addScoringEvent({
          type: "penalty",
          dimension: "documentation",
          points: 5,
          reason: `Attempted to skip to ${attemptedPhase} from ${currentPhase}`,
          timestamp: Date.now(),
        });
        recalculateScore();
      }
    },
    [currentPhase, addScoringEvent, recalculateScore]
  );

  const penalizeUnsafeAction = useCallback(
    (reason: string) => {
      addScoringEvent({
        type: "penalty",
        dimension: "safety",
        points: 5,
        reason,
        timestamp: Date.now(),
      });
      recalculateScore();
    },
    [addScoringEvent, recalculateScore]
  );

  const awardAccuracy = useCallback(
    (points: number, reason: string) => {
      addScoringEvent({
        type: "bonus",
        dimension: "accuracy",
        points,
        reason,
        timestamp: Date.now(),
      });
      recalculateScore();
    },
    [addScoringEvent, recalculateScore]
  );

  return {
    checkDashboardAccess,
    penalizePhaseSkip,
    penalizeUnsafeAction,
    awardAccuracy,
    commandCount,
  };
}
