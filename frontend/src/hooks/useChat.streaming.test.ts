import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "@/stores/gameStore";
import { useChat } from "./useChat";

const originalFetch = globalThis.fetch;

function createStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }

          const value = encoder.encode(chunks[index]);
          index += 1;
          return { done: false, value };
        },
      }),
    },
  } as Response;
}

describe("useChat streaming", () => {
  beforeEach(() => {
    useGameStore.getState().resetGame();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
      return;
    }

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  });

  it("reassembles SSE events split across chunk boundaries", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        createStreamResponse([
          'data: {"text":"Hello ',
          'world [PHASE:context] [SCORE:efficiency:+2:Fast] [RESOLVED]"}\n\n',
          "data: [DONE]\n\n",
        ])
      ),
    });

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage("Investigate the alert");
    });

    const state = useGameStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]?.content).toBe(
      "Hello world [PHASE:context] [SCORE:efficiency:+2:Fast] [RESOLVED]"
    );
    expect(state.currentPhase).toBe("context");
    expect(state.scoringEvents).toHaveLength(1);
    expect(state.scoringEvents[0]).toMatchObject({
      type: "bonus",
      dimension: "efficiency",
      points: 2,
      reason: "Fast",
    });
    expect(state.score.total).toBe(2);
    expect(state.status).toBe("completed");
    expect(state.isStreaming).toBe(false);
  });

  it("surfaces malformed SSE payloads as chat errors", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        createStreamResponse([
          'data: {"text":"Hello"}\n\n',
          'data: {"text":not-json}\n\n',
        ])
      ),
    });

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage("Investigate the alert");
    });

    const state = useGameStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]?.content).toContain("Error:");
    expect(state.messages[1]?.content).toContain("Please try again.");
    expect(state.isStreaming).toBe(false);
  });
});
