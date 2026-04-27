"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useGameStore } from "@/stores/gameStore";
import { GameLayout } from "@/components/layout/GameLayout";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { RightPanel, type RightPanelTab } from "@/components/layout/RightPanel";
import { ScoreBreakdown } from "@/components/scoring/ScoreBreakdown";
import { IncidentTicket } from "@/components/shared/IncidentTicket";
import { OnboardingTour, resetOnboardingTour, hasSeenOnboardingTour } from "@/components/onboarding/OnboardingTour";
import { useCommand } from "@/hooks/useCommand";
import {
  buildGameplayTelemetryPayload,
  sendGameplayTelemetryEvent,
  shouldSendAbandonmentEvent,
} from "@/lib/gameplayTelemetry";

export default function GamePage() {
  const router = useRouter();
  const scenario = useGameStore((s) => s.scenario);
  const status = useGameStore((s) => s.status);
  const sessionToken = useGameStore((s) => s.sessionToken);
  const { executeCommand } = useCommand();
  const completionSentRef = useRef(false);

  const [activeTab, setActiveTab] = useState<RightPanelTab>("terminal");
  const [showTour, setShowTour] = useState(() => !hasSeenOnboardingTour());

  useEffect(() => {
    if (!scenario || status === "idle") {
      router.push("/");
    }
  }, [scenario, status, router]);

  useEffect(() => {
    completionSentRef.current = false;
  }, [sessionToken]);

  useEffect(() => {
    if (status !== "completed" || completionSentRef.current) return;

    const state = useGameStore.getState();
    if (!state.sessionToken) return;

    sendGameplayTelemetryEvent(
      buildGameplayTelemetryPayload(state, "completed"),
    );
    completionSentRef.current = true;
  }, [status]);

  useEffect(() => {
    const handlePageHide = () => {
      const state = useGameStore.getState();
      if (!shouldSendAbandonmentEvent(state)) return;

      sendGameplayTelemetryEvent(
        buildGameplayTelemetryPayload(state, "abandoned"),
      );
    };

    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, []);

  const handleTourComplete = useCallback(({ completed }: { completed: boolean }) => {
    setShowTour(false);
    if (completed) setActiveTab("guide");
  }, []);

  const handleTourRestart = useCallback(() => {
    resetOnboardingTour();
    setShowTour(true);
  }, []);

  if (!scenario) return null;

  const handleRunCommand = (command: string, type: "oc" | "kql" | "geneva") => {
    executeCommand(command, type);
  };

  return (
    <>
      <GameLayout
        onTourRestart={handleTourRestart}
        chatPanel={
          <div className="flex flex-col h-full bg-zinc-900 border-r border-zinc-700">
            <IncidentTicket ticket={scenario.incidentTicket} />
            <div className="flex-1 min-h-0">
              <ChatPanel onRunCommand={handleRunCommand} />
            </div>
          </div>
        }
        rightPanel={
          <RightPanel activeTab={activeTab} onTabChange={setActiveTab} />
        }
      />
      {status === "completed" && <ScoreBreakdown />}
      {showTour && <OnboardingTour onComplete={handleTourComplete} />}
    </>
  );
}
