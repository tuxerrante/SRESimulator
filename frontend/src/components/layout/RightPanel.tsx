"use client";

import { TerminalPanel } from "@/components/terminal/TerminalPanel";
import { DashboardPanel } from "@/components/dashboard/DashboardPanel";
import { GuidePanel } from "@/components/guide/GuidePanel";
import { useGameStore } from "@/stores/gameStore";
import { cn } from "@/lib/utils";
import { Terminal, LayoutDashboard, Loader2, BookOpen } from "lucide-react";

export type RightPanelTab = "terminal" | "dashboard" | "guide";

interface RightPanelProps {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
}

export function RightPanel({ activeTab, onTabChange }: RightPanelProps) {
  const setActiveTab = onTabChange;
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
          data-tour="dashboard-tab"
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
        <button
          data-tour="guide-tab"
          onClick={() => setActiveTab("guide")}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors border-b-2",
            activeTab === "guide"
              ? "border-purple-500 text-purple-400"
              : "border-transparent text-zinc-500 hover:text-zinc-300"
          )}
        >
          <BookOpen size={14} />
          Guide
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {activeTab === "terminal" && <TerminalPanel />}
        {activeTab === "dashboard" && <DashboardPanel />}
        {activeTab === "guide" && <GuidePanel />}
      </div>
    </div>
  );
}
