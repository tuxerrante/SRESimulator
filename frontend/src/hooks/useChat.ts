"use client";

import { useCallback, useState } from "react";
import { useGameStore } from "@/stores/gameStore";
import { extractPhase, extractScoreMarkers, extractResolved } from "@/lib/chat-markers";
import { buildTelemetryHeaders } from "@/lib/telemetry/request-context";
import { captureFrontendError } from "@/lib/telemetry/capture";
import type { ChatMessage } from "@shared/types/chat";

const TIMEOUT_ERROR_MESSAGE =
  "The request timed out before the Dungeon Master could reply. Please try again.";

class ChatRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ChatRequestError";
    this.retryable = retryable;
  }
}

function isGatewayTimeout(status: number | null, message: string): boolean {
  return status === 504 || /\b504\b|gateway timeout/i.test(message);
}

function formatGenericChatError(message: string): string {
  const normalized = message.trim().replace(/^Error:\s*/i, "").replace(/[.!?\s]+$/, "");
  return `Error: ${normalized}. Please try again.`;
}

function toUserFacingChatError(error: unknown): ChatRequestError {
  if (error instanceof ChatRequestError) return error;

  const message = error instanceof Error ? error.message : "Unknown error";
  if (isGatewayTimeout(null, message)) {
    return new ChatRequestError(TIMEOUT_ERROR_MESSAGE, true);
  }

  return new ChatRequestError(formatGenericChatError(message));
}

function getNextSseEvent(buffer: string): { data: string; rest: string } | null {
  const normalizedBuffer = buffer.replace(/\r\n/g, "\n");
  const separatorIndex = normalizedBuffer.indexOf("\n\n");
  if (separatorIndex === -1) {
    return null;
  }

  const rawEvent = normalizedBuffer.slice(0, separatorIndex);
  const data = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n");

  return {
    data,
    rest: normalizedBuffer.slice(separatorIndex + 2),
  };
}

export function useChat() {
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const {
    messages,
    isStreaming,
    scenario,
    sessionToken,
    currentPhase,
    addMessage,
    updateLastAssistantMessage,
    setStreaming,
    setPhase,
    addScoringEvent,
    recalculateScore,
    endGame,
  } = useGameStore();

  const sendMessage = useCallback(
    async (content: string, options?: { retry?: boolean }) => {
      const trimmedContent = content.trim();
      if (isStreaming || !trimmedContent) return;

      setRetryMessage(null);

      const shouldReuseFailedTurn =
        options?.retry === true &&
        messages.length >= 2 &&
        messages[messages.length - 1]?.role === "assistant" &&
        messages[messages.length - 2]?.role === "user" &&
        messages[messages.length - 2]?.content === trimmedContent;

      let chatMessages: Array<{ role: "user" | "assistant"; content: string }>;

      if (shouldReuseFailedTurn) {
        updateLastAssistantMessage("");
        chatMessages = messages
          .slice(0, -1)
          .map((message) => ({ role: message.role, content: message.content }));
      } else {
        const userMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content: trimmedContent,
          timestamp: Date.now(),
        };
        addMessage(userMessage);

        const assistantMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
        };
        addMessage(assistantMessage);

        chatMessages = [
          ...messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          { role: userMessage.role, content: userMessage.content },
        ];
      }
      setStreaming(true);

      let telemetryHeaders: Record<string, string> = {};

      try {
        telemetryHeaders = await buildTelemetryHeaders(sessionToken);

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...telemetryHeaders,
          },
          body: JSON.stringify({
            messages: chatMessages,
            scenario,
            currentPhase,
          }),
        });

        if (!response.ok) {
          const raw = await response.text();
          let errorMessage = `Chat request failed (${response.status})`;
          try {
            const err = JSON.parse(raw);
            errorMessage = err.error || errorMessage;
          } catch {
            errorMessage = `Server error (${response.status}): ${raw.slice(0, 120)}`;
          }
          if (isGatewayTimeout(response.status, errorMessage)) {
            throw new ChatRequestError(TIMEOUT_ERROR_MESSAGE, true);
          }
          throw new Error(errorMessage);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";
        let streamDone = false;

        const processBufferedEvents = () => {
          while (true) {
            const event = getNextSseEvent(buffer);
            if (!event) return;

            buffer = event.rest;
            const data = event.data;
            if (!data) continue;

            if (data === "[DONE]") {
              streamDone = true;
              return;
            }

            try {
              const parsed = JSON.parse(data);
              if (parsed.error) throw new Error(parsed.error);
              if (parsed.reasoning) {
                updateLastAssistantMessage("_The AI is thinking deeper..._");
                continue;
              }
              if (parsed.text) {
                accumulated += parsed.text;
                updateLastAssistantMessage(accumulated);
              }
            } catch (e) {
              throw e;
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            processBufferedEvents();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          processBufferedEvents();
          if (streamDone) break;
        }

        // Post-stream processing
        const phase = extractPhase(accumulated);
        if (phase) setPhase(phase);

        const scoreEvents = extractScoreMarkers(accumulated);
        for (const event of scoreEvents) {
          addScoringEvent(event);
        }
        if (scoreEvents.length > 0) recalculateScore();

        if (extractResolved(accumulated)) endGame();
        setRetryMessage(null);
      } catch (error) {
        captureFrontendError(error, {
          feature: "chat",
          phase: currentPhase,
          difficulty: scenario?.difficulty,
          requestId: telemetryHeaders["x-sresim-request-id"],
          actorRef: telemetryHeaders["x-sresim-actor-ref"],
          gameSessionRef: telemetryHeaders["x-sresim-game-session-ref"],
        });
        const chatError = toUserFacingChatError(error);
        updateLastAssistantMessage(chatError.message);
        if (chatError.retryable) {
          setRetryMessage(trimmedContent);
        }
      } finally {
        setStreaming(false);
      }
    },
    [
      messages,
      isStreaming,
      scenario,
      sessionToken,
      currentPhase,
      addMessage,
      updateLastAssistantMessage,
      setStreaming,
      setPhase,
      addScoringEvent,
      recalculateScore,
      endGame,
    ]
  );

  const retryLastMessage = useCallback(() => {
    if (!retryMessage || isStreaming) return;
    void sendMessage(retryMessage, { retry: true });
  }, [retryMessage, isStreaming, sendMessage]);

  return {
    messages,
    isStreaming,
    sendMessage,
    retryLastMessage,
    canRetryLastMessage: Boolean(retryMessage) && !isStreaming,
  };
}
