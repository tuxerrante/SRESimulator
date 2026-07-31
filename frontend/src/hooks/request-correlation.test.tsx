import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_REF_HEADER,
  GAME_SESSION_REF_HEADER,
  REQUEST_ID_HEADER,
} from "@shared/telemetry/constants";
import type { Scenario } from "@shared/types/game";
import { useGameStore } from "@/stores/gameStore";
import { useChat } from "./useChat";
import { useCommand } from "./useCommand";

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

function createChatResponse(): Response {
  let reads = 0;

  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (reads === 0) {
              reads += 1;
              return {
                done: false,
                value: new TextEncoder().encode("data: [DONE]\n\n"),
              };
            }

            return {
              done: true,
              value: undefined,
            };
          },
        };
      },
    },
  } as Response;
}

function createCommandResponse(): Response {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ output: "ok", exitCode: 0 });
    },
  } as Response;
}

function readHeader(
  headers: HeadersInit | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  if (Array.isArray(headers)) {
    return headers.find(([headerName]) => headerName.toLowerCase() === name)?.[1];
  }

  return Object.entries(headers).find(
    ([headerName]) => headerName.toLowerCase() === name,
  )?.[1];
}

describe("frontend proxy request correlation", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
    useGameStore.getState().resetGame();
    vi.restoreAllMocks();
  });

  it("sends pseudonymous telemetry headers with chat proxy requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createChatResponse());
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    useGameStore.getState().startGame(createScenario(), "session-raw-token");

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage("check the cluster");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(readHeader(init.headers, "content-type")).toBe("application/json");
    expect(readHeader(init.headers, REQUEST_ID_HEADER)).toBeTruthy();
    expect(readHeader(init.headers, ACTOR_REF_HEADER)).toBeTruthy();
    expect(readHeader(init.headers, GAME_SESSION_REF_HEADER)).toMatch(/^[0-9a-f]{16}$/);
    expect(readHeader(init.headers, GAME_SESSION_REF_HEADER)).not.toBe("session-raw-token");
  });

  it("sends pseudonymous telemetry headers with command proxy requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createCommandResponse());
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    useGameStore.getState().startGame(createScenario(), "session-raw-token");

    const { result } = renderHook(() => useCommand());

    await act(async () => {
      await result.current.executeCommand("oc get pods", "oc");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(readHeader(init.headers, "content-type")).toBe("application/json");
    expect(readHeader(init.headers, REQUEST_ID_HEADER)).toBeTruthy();
    expect(readHeader(init.headers, ACTOR_REF_HEADER)).toBeTruthy();
    expect(readHeader(init.headers, GAME_SESSION_REF_HEADER)).toMatch(/^[0-9a-f]{16}$/);
    expect(readHeader(init.headers, GAME_SESSION_REF_HEADER)).not.toBe("session-raw-token");
  });
});
