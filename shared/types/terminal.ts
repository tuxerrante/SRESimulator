export interface TerminalEntry {
  id: string;
  command: string;
  output: string;
  timestamp: number;
  exitCode: number;
  type: "oc" | "kql" | "geneva";
}
