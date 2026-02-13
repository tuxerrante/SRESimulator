"use client";

import type { TerminalEntry } from "@/types/terminal";
import { cn } from "@/lib/utils";

interface CommandBlockProps {
  entry: TerminalEntry;
}

const TYPE_COLORS: Record<string, string> = {
  oc: "text-emerald-400",
  kql: "text-blue-400",
  geneva: "text-purple-400",
};

export function CommandBlock({ entry }: CommandBlockProps) {
  const time = new Date(entry.timestamp).toLocaleTimeString();

  return (
    <div className="font-mono text-sm mb-3">
      <div className="flex items-center gap-2 text-zinc-500 text-xs mb-0.5">
        <span>{time}</span>
        <span className={cn("uppercase font-bold text-[10px]", TYPE_COLORS[entry.type])}>
          [{entry.type}]
        </span>
      </div>
      <div className="flex items-start">
        <span className="text-emerald-500 mr-2 select-none">$</span>
        <span className="text-zinc-200">{entry.command}</span>
      </div>
      <pre className="mt-1 text-zinc-400 whitespace-pre-wrap text-xs leading-relaxed pl-4">
        {entry.output}
      </pre>
      {entry.exitCode !== 0 && (
        <div className="text-red-400 text-xs mt-0.5 pl-4">
          exit code: {entry.exitCode}
        </div>
      )}
    </div>
  );
}
