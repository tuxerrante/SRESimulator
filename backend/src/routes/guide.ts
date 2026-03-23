import { Router } from "express";
import { loadGuideContent } from "../lib/knowledge";

export const guideRouter = Router();

guideRouter.get("/", async (_req, res) => {
  try {
    const content = await loadGuideContent();
    res.json({ content });
  } catch {
    res.status(500).json({ error: "Failed to load guide content" });
  }
});
