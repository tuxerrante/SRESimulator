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
import { useCommand } from "./useCommand";

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

describe("useCommand", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
    useGameStore.getState().resetGame();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.mocked(buildTelemetryHeaders).mockResolvedValue({
      [REQUEST_ID_HEADER]: "req-123",
      [ACTOR_REF_HEADER]: "actor-123",
      [GAME_SESSION_REF_HEADER]: "gsr-123",
    });
  });

  it("captures safe telemetry when the command request fails", async () => {
    const networkError = new Error("proxy down");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

    useGameStore.getState().startGame(createScenario(), "session-raw-token");

    const { result } = renderHook(() => useCommand());

    await act(async () => {
      await result.current.executeCommand("oc get pods", "oc");
    });

    expect(captureFrontendError).toHaveBeenCalledWith(networkError, {
      feature: "command",
      phase: "reading",
      difficulty: "easy",
      requestId: "req-123",
      actorRef: "actor-123",
      gameSessionRef: "gsr-123",
    });
    expect(useGameStore.getState().terminalEntries.at(-1)?.output).toBe(
      "Error: Failed to simulate command execution",
    );
  });

  it("does not leave execution locked when no session token is active", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCommand());

    await act(async () => {
      await result.current.executeCommand("oc get pods", "oc");
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(buildTelemetryHeaders).not.toHaveBeenCalled();
    expect(useGameStore.getState().isExecuting).toBe(false);
    expect(useGameStore.getState().terminalEntries.at(-1)?.output).toBe(
      "Error: Start a scenario before running commands",
    );
  });

  it("captures safe telemetry when the command proxy returns a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        async text() {
          return JSON.stringify({ error: "Proxy gateway failed", exitCode: 1 });
        },
      } as Response),
    );

    useGameStore.getState().startGame(createScenario(), "session-raw-token");

    const { result } = renderHook(() => useCommand());

    await act(async () => {
      await result.current.executeCommand("oc get pods", "oc");
    });

    expect(captureFrontendError).toHaveBeenCalledTimes(1);
    const [error, context] = vi.mocked(captureFrontendError).mock.calls[0] ?? [];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Command proxy request failed (502)");
    expect(context).toEqual({
      feature: "command",
      phase: "reading",
      difficulty: "easy",
      requestId: "req-123",
      actorRef: "actor-123",
      gameSessionRef: "gsr-123",
    });
    expect(useGameStore.getState().terminalEntries.at(-1)?.output).toBe("Proxy gateway failed");
  });
});
