import { describe, expect, it, beforeEach, afterEach } from "vitest";
import express from "express";
import { chatRouter } from "./chat";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/chat", chatRouter);
  return app;
}

async function postSSE(
  app: express.Express,
  path: string,
  body: unknown
): Promise<{ status: number; rawBody: string }> {
  const { request } = await import("http");
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Bad address"));
        return;
      }
      const payload = JSON.stringify(body);
      const req = request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({
              status: res.statusCode ?? 500,
              rawBody: data,
            });
          });
        }
      );
      req.on("error", (e) => {
        server.close();
        reject(e);
      });
      req.write(payload);
      req.end();
    });
  });
}

describe("POST /api/chat", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.AI_MOCK_MODE = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  afterEach(() => {
    if (originalEnv.AI_MOCK_MODE === undefined) {
      delete process.env.AI_MOCK_MODE;
    } else {
      process.env.AI_MOCK_MODE = originalEnv.AI_MOCK_MODE;
    }
  });

  it("returns SSE stream with mock chat response", async () => {
    const app = createApp();
    const res = await postSSE(app, "/api/chat", {
      messages: [{ role: "user", content: "hello" }],
      scenario: null,
      currentPhase: "reading",
    });

    expect(res.status).toBe(200);
    expect(res.rawBody).toContain("data: ");
    expect(res.rawBody).toContain("[DONE]");

    const lines = res.rawBody
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    expect(lines.length).toBeGreaterThan(0);

    const parsed = JSON.parse(lines[0].slice(6));
    expect(parsed.text).toContain("Mock AI mode is enabled");
    expect(parsed.text).toContain("[PHASE:reading]");
  });

  it("reflects the current phase in the response", async () => {
    const app = createApp();
    const res = await postSSE(app, "/api/chat", {
      messages: [{ role: "user", content: "checking context" }],
      scenario: null,
      currentPhase: "context",
    });

    expect(res.rawBody).toContain("[PHASE:context]");
  });
});
