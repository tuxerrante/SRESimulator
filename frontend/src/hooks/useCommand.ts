"use client";

import { useCallback } from "react";
import { useGameStore } from "@/stores/gameStore";
import type { TerminalEntry } from "@/types/terminal";

export const COMMAND_COOLDOWN_MS = 60_000;

export function useCommand() {
  const { scenario, addTerminalEntry, addScoringEvent, recalculateScore, setExecuting } =
    useGameStore();

  const getCooldownRemaining = useCallback((): number => {
    const { lastCommandTime } = useGameStore.getState();
    if (!lastCommandTime) return 0;
    const elapsed = Date.now() - lastCommandTime;
    return Math.max(0, COMMAND_COOLDOWN_MS - elapsed);
  }, []);

  const executeCommand = useCallback(
    async (command: string, type: "oc" | "kql" | "geneva") => {
      if (useGameStore.getState().isExecuting) return;

      const remaining = getCooldownRemaining();
      if (remaining > 0) return;

      setExecuting(true);

      // Scoring checks before execution
      const state = useGameStore.getState();

      // Penalize running commands without checking dashboard first
      if (!state.checkedDashboard && state.commandCount === 0) {
        addScoringEvent({
          type: "penalty",
          dimension: "safety",
          points: 5,
          reason: "Ran commands without checking dashboard first",
          timestamp: Date.now(),
        });
      }

      // Penalize running commands during reading phase
      if (state.currentPhase === "reading") {
        addScoringEvent({
          type: "penalty",
          dimension: "documentation",
          points: 3,
          reason: "Ran commands during Reading phase",
          timestamp: Date.now(),
        });
      }

      try {
        const response = await fetch("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command, type, scenario }),
        });

        const data = await response.json();

        const entry: TerminalEntry = {
          id: crypto.randomUUID(),
          command,
          output: data.output || data.error || "No output",
          timestamp: Date.now(),
          exitCode: data.exitCode ?? (data.error ? 1 : 0),
          type,
        };

        addTerminalEntry(entry);

        // Progressive efficiency penalty for excessive commands
        const commandCount = useGameStore.getState().commandCount;
        if (commandCount > 5 && commandCount % 3 === 0) {
          addScoringEvent({
            type: "penalty",
            dimension: "efficiency",
            points: 2,
            reason: `High command count (${commandCount} total)`,
            timestamp: Date.now(),
          });
        }

        recalculateScore();
      } catch {
        const entry: TerminalEntry = {
          id: crypto.randomUUID(),
          command,
          output: "Error: Failed to simulate command execution",
          timestamp: Date.now(),
          exitCode: 1,
          type,
        };
        addTerminalEntry(entry);
      } finally {
        setExecuting(false);
      }
    },
    [scenario, addTerminalEntry, addScoringEvent, recalculateScore, setExecuting, getCooldownRemaining]
  );

  return { executeCommand, getCooldownRemaining };
}
