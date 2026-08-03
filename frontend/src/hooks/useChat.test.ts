import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_REF_HEADER,
  GAME_SESSION_REF_HEADER,
  REQUEST_ID_HEADER,
} from "@shared/telemetry/constants";
import type { Scenario } from "@shared/types/game";
import { useGameStore } from "@/stores/gameStore";
import { buildTelemetryHeaders } from "@/lib/telemetry/request-context";
import { captureFrontendError } from "@/lib/telemetry/capture";
import { useChat } from "./useChat";

vi.mock("@/lib/telemetry/request-context", () => ({
  buildTelemetryHeaders: vi.fn(),
}));

vi.mock("@/lib/telemetry/capture", () => ({
  captureFrontendError: vi.fn(),
}));

const storage = new Map<string, string>();

const localStorageMock: Storage = {
  getItem(key: string) {
    return storage.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
  key(index: number) {
    return [...storage.keys()][index] ?? null;
  },
  get length() {
    return storage.size;
  },
};

function createScenario(): Scenario {
  return {
    id: "scenario-1",
    platform: "aro-classic",
    title: "Test scenario",
    difficulty: "easy",
    description: "Test description",
    incidentTicket: {
      id: "INC-1",
      severity: "Sev2",
      title: "Broken cluster",
      description: "Test incident",
      customerImpact: "Users impacted",
      reportedTime: "2026-05-08T12:00:00Z",
      clusterName: "cluster-a",
      region: "westeurope",
    },
    clusterContext: {
      name: "cluster-a",
      version: "4.18",
      region: "westeurope",
      nodeCount: 3,
      status: "Degraded",
      recentEvents: [],
      alerts: [],
      upgradeHistory: [],
    },
  };
}

describe("useChat", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
    useGameStore.getState().resetGame();
    vi.restoreAllMocks();
    vi.mocked(buildTelemetryHeaders).mockResolvedValue({
      [REQUEST_ID_HEADER]: "req-123",
      [ACTOR_REF_HEADER]: "actor-123",
      [GAME_SESSION_REF_HEADER]: "gsr-123",
    });
  });

  it("captures safe telemetry when the chat request fails", async () => {
    const networkError = new Error("network down");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

    useGameStore.getState().startGame(createScenario(), "session-raw-token");

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage("check the cluster");
    });

    expect(captureFrontendError).toHaveBeenCalledWith(networkError, {
      feature: "chat",
      phase: "reading",
      difficulty: "easy",
      platform: "aro-classic",
      requestId: "req-123",
      actorRef: "actor-123",
      gameSessionRef: "gsr-123",
    });
    expect(useGameStore.getState().messages.at(-1)?.content).toBe(
      "Error: network down. Please try again.",
    );
  });

  it("falls back to a generic chat error when upstream message normalizes empty", async () => {
    const noisyError = new Error("...  !!!");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(noisyError));

    useGameStore.getState().startGame(createScenario(), "session-raw-token");

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage("check the cluster");
    });

    expect(useGameStore.getState().messages.at(-1)?.content).toBe(
      "Error: Something went wrong. Please try again.",
    );
  });
});
