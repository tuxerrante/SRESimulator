"use client";

import { useGameStore } from "@/stores/gameStore";
import { cn } from "@/lib/utils";
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
            valueClass={
              clusterContext.status.toLowerCase().includes("healthy")
                ? "text-emerald-400"
                : "text-red-400"
            }
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
                  <div className="text-[10px] text-zinc-600 mt-0.5">
                    Firing since {alert.firingTime}
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
              className="text-xs text-zinc-400 px-3 py-1.5 rounded bg-zinc-900 border border-zinc-800"
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
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900 text-xs"
              >
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
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function InfoCard({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900">
      <div className="text-[10px] text-zinc-600 uppercase">{label}</div>
      <div className={cn("text-sm font-mono text-zinc-300", valueClass)}>
        {value}
      </div>
    </div>
  );
}
