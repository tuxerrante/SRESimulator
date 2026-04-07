export type MessageRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  phase?: InvestigationPhase;
  commands?: ExtractedCommand[];
}

export interface ExtractedCommand {
  type: "oc" | "kql" | "geneva";
  command: string;
  executed: boolean;
}

export type InvestigationPhase =
  | "reading"
  | "context"
  | "facts"
  | "theory"
  | "action";

export const PHASE_LABELS: Record<InvestigationPhase, string> = {
  reading: "Reading",
  context: "Context Gathering",
  facts: "Facts Gathering",
  theory: "Theory Building",
  action: "Action",
};

export const PHASE_ORDER: InvestigationPhase[] = [
  "reading",
  "context",
  "facts",
  "theory",
  "action",
];
