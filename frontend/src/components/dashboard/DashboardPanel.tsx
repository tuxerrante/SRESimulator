"use client";

import { useGameStore } from "@/stores/gameStore";
import { cn, formatRelativeTime, formatShortDateTime } from "@/lib/utils";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Info,
  Server,
  ArrowUpCircle,
} from "lucide-react";
import { useScoring } from "@/hooks/useScoring";
import { useEffect, useRef } from "react";

export function DashboardPanel() {
  const scenario = useGameStore((s) => s.scenario);
  const { checkDashboardAccess } = useScoring();
  const hasTracked = useRef(false);

  useEffect(() => {
    if (!hasTracked.current) {
      hasTracked.current = true;
      checkDashboardAccess();
    }
  }, [checkDashboardAccess]);

  if (!scenario) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
        No scenario loaded
      </div>
    );
  }

  const { clusterContext } = scenario;

  return (
    <div className="h-full overflow-y-auto bg-zinc-950 p-4 space-y-4">
      {/* Cluster Overview */}
      <section>
        <h3 className="text-xs font-semibold text-zinc-500 uppercase mb-2 flex items-center gap-1.5">
          <Server size={12} />
          Cluster Overview
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <InfoCard label="Name" value={clusterContext.name} />
          <InfoCard label="Version" value={clusterContext.version} />
          <InfoCard label="Region" value={clusterContext.region} />
          <InfoCard label="Nodes" value={String(clusterContext.nodeCount)} />
          <InfoCard
            label="Status"
            value={clusterContext.status}
            valueClass={statusColor(clusterContext.status)}
            className="col-span-2"
          />
        </div>
      </section>

      {/* Active Alerts */}
      <section>
        <h3 className="text-xs font-semibold text-zinc-500 uppercase mb-2 flex items-center gap-1.5">
          <AlertCircle size={12} />
          Active Alerts ({clusterContext.alerts.length})
        </h3>
        {clusterContext.alerts.length === 0 ? (
          <div className="text-xs text-zinc-600 px-3 py-2">
            No active alerts
          </div>
        ) : (
          <div className="space-y-1.5">
            {clusterContext.alerts.map((alert, i) => (
              <div
                key={i}
                className="flex items-start gap-2 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900"
              >
                {alert.severity === "critical" ? (
                  <AlertCircle
                    size={14}
                    className="text-red-400 mt-0.5 flex-shrink-0"
                  />
                ) : alert.severity === "warning" ? (
                  <AlertTriangle
                    size={14}
                    className="text-amber-400 mt-0.5 flex-shrink-0"
                  />
                ) : (
                  <Info
                    size={14}
                    className="text-blue-400 mt-0.5 flex-shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <div
                    className={cn(
                      "text-xs font-medium",
                      alert.severity === "critical" && "text-red-400",
                      alert.severity === "warning" && "text-amber-400",
                      alert.severity === "info" && "text-blue-400"
                    )}
                  >
                    {alert.name}
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {alert.message}
                  </div>
                  <div
                    className="text-[10px] text-zinc-600 mt-0.5"
                    title={alert.firingTime}
                  >
                    Firing since {formatRelativeTime(alert.firingTime)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent Events */}
      <section>
        <h3 className="text-xs font-semibold text-zinc-500 uppercase mb-2 flex items-center gap-1.5">
          <Activity size={12} />
          Recent Events
        </h3>
        <div className="space-y-1">
          {clusterContext.recentEvents.map((event, i) => (
            <div
              key={i}
              className={cn(
                "text-xs px-3 py-1.5 rounded bg-zinc-900 border border-zinc-800",
                eventColor(event),
              )}
            >
              {event}
            </div>
          ))}
        </div>
      </section>

      {/* Upgrade History */}
      <section>
        <h3 className="text-xs font-semibold text-zinc-500 uppercase mb-2 flex items-center gap-1.5">
          <ArrowUpCircle size={12} />
          Upgrade History
        </h3>
        {clusterContext.upgradeHistory.length === 0 ? (
          <div className="text-xs text-zinc-600 px-3 py-2">
            No upgrade history
          </div>
        ) : (
          <div className="space-y-1.5">
            {clusterContext.upgradeHistory.map((upgrade, i) => (
              <div
                key={i}
                className="px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="text-zinc-400 font-mono">
                    {upgrade.from}
                  </span>
                  <span className="text-zinc-600">&rarr;</span>
                  <span className="text-zinc-300 font-mono">{upgrade.to}</span>
                  <span
                    className={cn(
                      "ml-auto px-1.5 py-0.5 rounded font-medium",
                      upgrade.status === "completed" &&
                        "bg-emerald-600/20 text-emerald-400",
                      upgrade.status === "failed" &&
                        "bg-red-600/20 text-red-400",
                      upgrade.status === "in_progress" &&
                        "bg-amber-600/20 text-amber-400"
                    )}
                  >
                    {upgrade.status}
                  </span>
                </div>
                {upgrade.timestamp && (
                  <div
                    className="text-[10px] text-zinc-600 mt-1"
                    title={upgrade.timestamp}
                  >
                    {formatShortDateTime(upgrade.timestamp)} ({formatRelativeTime(upgrade.timestamp)})
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const DEGRADED_KEYWORDS = ["degraded", "error", "failed", "notready", "not ready", "down", "unavailable", "critical"];

function statusColor(status: string): string {
  const lower = status.toLowerCase();
  if (DEGRADED_KEYWORDS.some((kw) => lower.includes(kw))) return "text-red-400";
  if (lower.includes("healthy") || lower.includes("ready") || lower.includes("available")) return "text-emerald-400";
  return "text-amber-400";
}

function eventColor(event: string): string {
  const lower = event.toLowerCase();
  if (/\berror\b|failed|crashloop|oom/i.test(lower)) return "text-red-400 border-red-900/40";
  if (/\bwarning\b|unhealthy|backoff|evict/i.test(lower)) return "text-amber-400 border-amber-900/40";
  return "text-zinc-400";
}

function InfoCard({
  label,
  value,
  valueClass,
  className,
}: {
  label: string;
  value: string;
  valueClass?: string;
  className?: string;
}) {
  return (
    <div className={cn("px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900", className)}>
      <div className="text-[10px] text-zinc-600 uppercase">{label}</div>
      <div className={cn("text-sm font-mono text-zinc-300", valueClass)}>
        {value}
      </div>
    </div>
  );
}
