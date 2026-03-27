"use client";

import { useCallback } from "react";
import { useGameStore } from "@/stores/gameStore";
import { extractPhase, extractScoreMarkers, extractResolved } from "@/lib/chat-markers";
import type { ChatMessage } from "@shared/types/chat";

export function useChat() {
  const {
    messages,
    isStreaming,
    scenario,
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
    async (content: string) => {
      if (isStreaming || !content.trim()) return;

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: content.trim(),
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
      setStreaming(true);

      try {
        const chatMessages = [
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: userMessage.role, content: userMessage.content },
        ];

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
          throw new Error(errorMessage);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);

            if (data === "[DONE]") break;

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
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
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
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Unknown error";
        updateLastAssistantMessage(
          `Error: ${errMsg}. Please try again.`
        );
      } finally {
        setStreaming(false);
      }
    },
    [
      messages,
      isStreaming,
      scenario,
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

  return { messages, isStreaming, sendMessage };
}
