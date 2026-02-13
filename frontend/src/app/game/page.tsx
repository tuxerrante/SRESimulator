"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useGameStore } from "@/stores/gameStore";
import { GameLayout } from "@/components/layout/GameLayout";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { RightPanel } from "@/components/layout/RightPanel";
import { ScoreBreakdown } from "@/components/scoring/ScoreBreakdown";
import { IncidentTicket } from "@/components/shared/IncidentTicket";
import { useCommand } from "@/hooks/useCommand";

export default function GamePage() {
  const router = useRouter();
  const scenario = useGameStore((s) => s.scenario);
  const status = useGameStore((s) => s.status);
  const { executeCommand } = useCommand();

  useEffect(() => {
    if (!scenario || status === "idle") {
      router.push("/");
    }
  }, [scenario, status, router]);

  if (!scenario) return null;

  const handleRunCommand = (command: string, type: "oc" | "kql" | "geneva") => {
    executeCommand(command, type);
  };

  return (
    <>
      <GameLayout
        chatPanel={
          <div className="flex flex-col h-full bg-zinc-900 border-r border-zinc-700">
            <IncidentTicket ticket={scenario.incidentTicket} />
            <div className="flex-1 min-h-0">
              <ChatPanel onRunCommand={handleRunCommand} />
            </div>
          </div>
        }
        rightPanel={<RightPanel />}
      />
      {status === "completed" && <ScoreBreakdown />}
    </>
  );
}
