import { create } from "zustand";
import type { ChatMessage, InvestigationPhase } from "@/types/chat";
import type { Scenario, GameStatus } from "@/types/game";
import type { TerminalEntry } from "@/types/terminal";
import type { Score, ScoringEvent } from "@/types/scoring";

interface GameState {
  // Session
  status: GameStatus;
  scenario: Scenario | null;
  startTime: number | null;
  endTime: number | null;

  // Chat
  messages: ChatMessage[];
  isStreaming: boolean;

  // Investigation phase
  currentPhase: InvestigationPhase;
  phaseHistory: InvestigationPhase[];
  checkedDashboard: boolean;

  // Terminal
  terminalEntries: TerminalEntry[];
  commandCount: number;

  // Scoring
  score: Score;
  scoringEvents: ScoringEvent[];

  // Actions
  setStatus: (status: GameStatus) => void;
  setScenario: (scenario: Scenario) => void;
  startGame: (scenario: Scenario) => void;
  endGame: () => void;
  resetGame: () => void;

  addMessage: (message: ChatMessage) => void;
  updateLastAssistantMessage: (content: string) => void;
  setStreaming: (streaming: boolean) => void;

  setPhase: (phase: InvestigationPhase) => void;
  setCheckedDashboard: (checked: boolean) => void;

  addTerminalEntry: (entry: TerminalEntry) => void;

  addScoringEvent: (event: ScoringEvent) => void;
  recalculateScore: () => void;
}

const initialScore: Score = {
  efficiency: 25,
  safety: 25,
  documentation: 25,
  accuracy: 25,
  total: 100,
};

export const useGameStore = create<GameState>((set, get) => ({
  status: "idle",
  scenario: null,
  startTime: null,
  endTime: null,

  messages: [],
  isStreaming: false,

  currentPhase: "reading",
  phaseHistory: [],
  checkedDashboard: false,

  terminalEntries: [],
  commandCount: 0,

  score: { ...initialScore },
  scoringEvents: [],

  setStatus: (status) => set({ status }),
  setScenario: (scenario) => set({ scenario }),

  startGame: (scenario) =>
    set({
      status: "playing",
      scenario,
      startTime: Date.now(),
      endTime: null,
      messages: [],
      currentPhase: "reading",
      phaseHistory: ["reading"],
      checkedDashboard: false,
      terminalEntries: [],
      commandCount: 0,
      score: { ...initialScore },
      scoringEvents: [],
      isStreaming: false,
    }),

  endGame: () =>
    set({
      status: "completed",
      endTime: Date.now(),
    }),

  resetGame: () =>
    set({
      status: "idle",
      scenario: null,
      startTime: null,
      endTime: null,
      messages: [],
      currentPhase: "reading",
      phaseHistory: [],
      checkedDashboard: false,
      terminalEntries: [],
      commandCount: 0,
      score: { ...initialScore },
      scoringEvents: [],
      isStreaming: false,
    }),

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  updateLastAssistantMessage: (content) =>
    set((state) => {
      const messages = [...state.messages];
      const lastIdx = messages.length - 1;
      if (lastIdx >= 0 && messages[lastIdx].role === "assistant") {
        messages[lastIdx] = { ...messages[lastIdx], content };
      }
      return { messages };
    }),

  setStreaming: (isStreaming) => set({ isStreaming }),

  setPhase: (phase) =>
    set((state) => ({
      currentPhase: phase,
      phaseHistory: state.phaseHistory.includes(phase)
        ? state.phaseHistory
        : [...state.phaseHistory, phase],
    })),

  setCheckedDashboard: (checked) => set({ checkedDashboard: checked }),

  addTerminalEntry: (entry) =>
    set((state) => ({
      terminalEntries: [...state.terminalEntries, entry],
      commandCount: state.commandCount + 1,
    })),

  addScoringEvent: (event) =>
    set((state) => {
      const newEvents = [...state.scoringEvents, event];
      return { scoringEvents: newEvents };
    }),

  recalculateScore: () =>
    set((state) => {
      const score: Score = { ...initialScore };
      for (const event of state.scoringEvents) {
        const delta = event.type === "bonus" ? event.points : -event.points;
        score[event.dimension] = Math.max(
          0,
          Math.min(25, score[event.dimension] + delta)
        );
      }
      score.total =
        score.efficiency + score.safety + score.documentation + score.accuracy;
      return { score };
    }),
}));
