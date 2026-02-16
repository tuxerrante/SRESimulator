"use client";

import { useEffect, useRef } from "react";
import { useGameStore } from "@/stores/gameStore";
import { CommandBlock } from "./CommandBlock";
import { Terminal, Loader2 } from "lucide-react";

export function TerminalPanel() {
  const terminalEntries = useGameStore((s) => s.terminalEntries);
  const isExecuting = useGameStore((s) => s.isExecuting);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [terminalEntries, isExecuting]);

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-700 bg-zinc-900">
        <Terminal size={14} className="text-emerald-400" />
        <h2 className="text-sm font-semibold text-zinc-200">Terminal</h2>
        <span className="text-xs text-zinc-500 ml-auto">
          {terminalEntries.length} command{terminalEntries.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {terminalEntries.length === 0 && !isExecuting && (
          <div className="flex flex-col items-center justify-center h-full text-zinc-700 text-sm gap-2">
            <Terminal size={32} />
            <span>Command output will appear here</span>
            <span className="text-xs">Click &quot;Run&quot; on commands in the chat panel</span>
          </div>
        )}
        {terminalEntries.map((entry) => (
          <CommandBlock key={entry.id} entry={entry} />
        ))}
        {isExecuting && (
          <div className="flex items-center gap-2 px-3 py-2 mt-2 text-sm text-zinc-400">
            <Loader2 size={14} className="animate-spin text-emerald-400" />
            <span className="font-mono text-xs">Simulating command execution...</span>
          </div>
        )}
      </div>
    </div>
  );
}
