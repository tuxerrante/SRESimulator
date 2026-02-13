export type Difficulty = "easy" | "medium" | "hard";

export interface Scenario {
  id: string;
  title: string;
  difficulty: Difficulty;
  description: string;
  incidentTicket: IncidentTicket;
  clusterContext: ClusterContext;
}

export interface IncidentTicket {
  id: string;
  severity: "Sev1" | "Sev2" | "Sev3" | "Sev4";
  title: string;
  description: string;
  customerImpact: string;
  reportedTime: string;
  clusterName: string;
  region: string;
}

export interface ClusterContext {
  name: string;
  version: string;
  region: string;
  nodeCount: number;
  status: string;
  recentEvents: string[];
  alerts: Alert[];
  upgradeHistory: UpgradeEvent[];
}

export interface Alert {
  name: string;
  severity: "critical" | "warning" | "info";
  message: string;
  firingTime: string;
}

export interface UpgradeEvent {
  from: string;
  to: string;
  status: "completed" | "failed" | "in_progress";
  timestamp: string;
}

export type GameStatus = "idle" | "selecting" | "playing" | "completed";
