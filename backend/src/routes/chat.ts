import { Router, type Request, type Response } from "express";
import { getClaudeClient, CLAUDE_MODEL } from "../lib/claude";
import { loadKnowledgeBase } from "../lib/knowledge";
import { buildSystemPrompt } from "../lib/prompts/system";
import type { Scenario } from "../../../shared/types/game";
import type { InvestigationPhase } from "../../../shared/types/chat";

export const chatRouter = Router();

interface ChatRequestBody {
  messages: { role: "user" | "assistant"; content: string }[];
  scenario: Scenario | null;
  currentPhase: InvestigationPhase;
}

chatRouter.post("/", async (req: Request, res: Response) => {
  try {
    const body: ChatRequestBody = req.body;
    const { messages, scenario, currentPhase } = body;

    const knowledgeBase = await loadKnowledgeBase();
    const systemPrompt = buildSystemPrompt(knowledgeBase, scenario, currentPhase);

    const client = getClaudeClient();

    const stream = await client.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          const data = JSON.stringify({ text: event.delta.text });
          res.write(`data: ${data}\n\n`);
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : "Stream error";
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ error: message });
  }
});
