"use client";

import { useCallback, useState } from "react";
import { useGameStore } from "@/stores/gameStore";
import type { TerminalEntry } from "@/types/terminal";

export function useCommand() {
  const { scenario, addTerminalEntry, addScoringEvent, recalculateScore } =
    useGameStore();
  const [isExecuting, setIsExecuting] = useState(false);

  const executeCommand = useCallback(
    async (command: string, type: "oc" | "kql" | "geneva") => {
      if (isExecuting) return;
      setIsExecuting(true);

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

        // Score efficiency penalty for excessive commands
        const commandCount = useGameStore.getState().commandCount;
        if (commandCount > 10) {
          addScoringEvent({
            type: "penalty",
            dimension: "efficiency",
            points: 2,
            reason: `Excessive commands (${commandCount} total)`,
            timestamp: Date.now(),
          });
          recalculateScore();
        }
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
        setIsExecuting(false);
      }
    },
    [isExecuting, scenario, addTerminalEntry, addScoringEvent, recalculateScore]
  );

  return { executeCommand, isExecuting };
}
