import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat";
import { commandRouter } from "./routes/command";
import { scenarioRouter } from "./routes/scenario";
import { scoresRouter } from "./routes/scores";
import { healthRouter } from "./routes/health";
import { aiRouter } from "./routes/ai";
import { getAiReadiness } from "./lib/ai-config";

const app = express();
const PORT = parseInt(process.env.PORT || "8080", 10);
const aiReadiness = getAiReadiness();

if (aiReadiness.strictStartup && !aiReadiness.ready) {
  throw new Error(
    `Backend startup blocked: ${aiReadiness.reasons.join("; ")}`
  );
}

app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
}));
app.use(express.json());

// Routes
app.use("/api/chat", chatRouter);
app.use("/api/command", commandRouter);
app.use("/api/scenario", scenarioRouter);
app.use("/api/scores", scoresRouter);
app.use("/api/ai", aiRouter);
app.use("/", healthRouter);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend listening on port ${PORT}`);
});
