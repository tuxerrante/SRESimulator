"use client";

import { useState } from "react";
import { TerminalPanel } from "@/components/terminal/TerminalPanel";
import { DashboardPanel } from "@/components/dashboard/DashboardPanel";
import { useGameStore } from "@/stores/gameStore";
import { cn } from "@/lib/utils";
import { Terminal, LayoutDashboard, Loader2 } from "lucide-react";

type Tab = "terminal" | "dashboard";

export function RightPanel() {
  const [activeTab, setActiveTab] = useState<Tab>("terminal");
  const isExecuting = useGameStore((s) => s.isExecuting);

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-zinc-700 bg-zinc-900">
        <button
          onClick={() => setActiveTab("terminal")}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors border-b-2",
            activeTab === "terminal"
              ? "border-emerald-500 text-emerald-400"
              : "border-transparent text-zinc-500 hover:text-zinc-300"
          )}
        >
          {isExecuting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Terminal size={14} />
          )}
          Terminal
        </button>
        <button
          onClick={() => setActiveTab("dashboard")}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors border-b-2",
            activeTab === "dashboard"
              ? "border-blue-500 text-blue-400"
              : "border-transparent text-zinc-500 hover:text-zinc-300"
          )}
        >
          <LayoutDashboard size={14} />
          Dashboard
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {activeTab === "terminal" ? <TerminalPanel /> : <DashboardPanel />}
      </div>
    </div>
  );
}
