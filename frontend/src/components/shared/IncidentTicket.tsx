"use client";

import type { IncidentTicket as IncidentTicketType } from "@/types/game";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";

interface IncidentTicketProps {
  ticket: IncidentTicketType;
}

const SEV_COLORS: Record<string, string> = {
  Sev1: "bg-red-600/20 text-red-400 ring-red-600/50",
  Sev2: "bg-orange-600/20 text-orange-400 ring-orange-600/50",
  Sev3: "bg-amber-600/20 text-amber-400 ring-amber-600/50",
  Sev4: "bg-blue-600/20 text-blue-400 ring-blue-600/50",
};

export function IncidentTicket({ ticket }: IncidentTicketProps) {
  return (
    <div className="border-b border-zinc-700 bg-zinc-800/50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800 border-b border-zinc-700">
        <AlertTriangle size={14} className="text-amber-500" />
        <span className="text-xs font-semibold text-zinc-300">
          INCIDENT TICKET
        </span>
        <span
          className={cn(
            "text-xs px-1.5 py-0.5 rounded font-bold ring-1",
            SEV_COLORS[ticket.severity]
          )}
        >
          {ticket.severity}
        </span>
        <span className="text-xs text-zinc-500 ml-auto">{ticket.id}</span>
      </div>
      <div className="px-3 py-2 space-y-2 text-sm">
        <div>
          <span className="font-semibold text-zinc-200">{ticket.title}</span>
        </div>
        <div className="text-zinc-400 text-xs leading-relaxed">
          {ticket.description}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <div>
            <span className="text-zinc-500">Customer Impact: </span>
            <span className="text-zinc-300">{ticket.customerImpact}</span>
          </div>
          <div>
            <span className="text-zinc-500">Reported: </span>
            <span className="text-zinc-300">{ticket.reportedTime}</span>
          </div>
          <div>
            <span className="text-zinc-500">Cluster: </span>
            <span className="text-zinc-300 font-mono">{ticket.clusterName}</span>
          </div>
          <div>
            <span className="text-zinc-500">Region: </span>
            <span className="text-zinc-300">{ticket.region}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
