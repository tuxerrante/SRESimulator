"use client";

import { useCallback } from "react";
import { useGameStore } from "@/stores/gameStore";
import { buildTelemetryHeaders } from "@/lib/telemetry/request-context";
import { captureFrontendError } from "@/lib/telemetry/capture";
import {
  ACTOR_REF_HEADER,
  GAME_SESSION_REF_HEADER,
  REQUEST_ID_HEADER,
} from "@shared/telemetry/constants";
import type { TerminalEntry } from "@shared/types/terminal";

const MAX_COMMAND_HISTORY = 24;
const MAX_ENTRY_OUTPUT_CHARS = 800;

export function useCommand() {
  const { scenario, addTerminalEntry, addScoringEvent, recalculateScore, setExecuting } =
    useGameStore();

  const executeCommand = useCallback(
    async (command: string, type: "oc" | "kql" | "geneva") => {
      if (useGameStore.getState().isExecuting) return;
      setExecuting(true);

      // Scoring checks before execution
      const state = useGameStore.getState();
      const activeSessionToken = state.sessionToken;

      if (!activeSessionToken) {
        addTerminalEntry({
          id: crypto.randomUUID(),
          command,
          output: "Error: Start a scenario before running commands",
          timestamp: Date.now(),
          exitCode: 1,
          type,
        });
        return;
      }

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

      let telemetryHeaders: Record<string, string> = {};
      const buildCommandTelemetryContext = () => ({
        feature: "command",
        phase: state.currentPhase,
        difficulty: scenario?.difficulty,
        requestId: telemetryHeaders[REQUEST_ID_HEADER],
        actorRef: telemetryHeaders[ACTOR_REF_HEADER],
        gameSessionRef: telemetryHeaders[GAME_SESSION_REF_HEADER],
      });

      try {
        const entries = useGameStore.getState().terminalEntries;
        const commandHistory = entries.slice(-MAX_COMMAND_HISTORY).map((e) => ({
          command: e.command,
          output: e.output.length > MAX_ENTRY_OUTPUT_CHARS
            ? e.output.slice(0, MAX_ENTRY_OUTPUT_CHARS) + "\n...(truncated)"
            : e.output,
          type: e.type,
        }));
        telemetryHeaders = await buildTelemetryHeaders(activeSessionToken);

        const response = await fetch("/api/command", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...telemetryHeaders,
          },
          body: JSON.stringify({
            sessionToken: activeSessionToken,
            command,
            type,
            scenario,
            commandHistory,
          }),
        });

        const raw = await response.text();
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          data = { error: `Server error (${response.status})`, exitCode: 1 };
        }

        if (!response.ok) {
          captureFrontendError(
            new Error(`Command proxy request failed (${response.status})`),
            buildCommandTelemetryContext(),
          );
        }
        if (data.mode === "degraded") {
          captureFrontendError(
            new Error(
              `Command simulation degraded (${String(data.degradedReason || "unknown")})`,
            ),
            buildCommandTelemetryContext(),
          );
        }

        const entry: TerminalEntry = {
          id: crypto.randomUUID(),
          command,
          output: String(data.output || data.error || "No output"),
          timestamp: Date.now(),
          exitCode: typeof data.exitCode === "number" ? data.exitCode : (data.error ? 1 : 0),
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
      } catch (error) {
        captureFrontendError(error, buildCommandTelemetryContext());
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
    [scenario, addTerminalEntry, addScoringEvent, recalculateScore, setExecuting]
  );

  return { executeCommand };
}
