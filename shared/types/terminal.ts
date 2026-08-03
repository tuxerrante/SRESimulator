import type { CompatibleCommandType } from "./platform";

export interface TerminalEntry {
  id: string;
  command: string;
  output: string;
  timestamp: number;
  exitCode: number;
  type: CompatibleCommandType;
}
