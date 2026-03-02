import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat";
import { commandRouter } from "./routes/command";
import { scenarioRouter } from "./routes/scenario";
import { scoresRouter } from "./routes/scores";
import { healthRouter } from "./routes/health";

const app = express();
const PORT = parseInt(process.env.PORT || "8080", 10);

app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
}));
app.use(express.json());

// Routes
app.use("/api/chat", chatRouter);
app.use("/api/command", commandRouter);
app.use("/api/scenario", scenarioRouter);
app.use("/api/scores", scoresRouter);
app.use("/", healthRouter);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend listening on port ${PORT}`);
});
