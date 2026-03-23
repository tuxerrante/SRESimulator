import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import { request as httpRequest } from "http";

vi.mock("../lib/knowledge", () => ({
  loadGuideContent: vi.fn(),
}));

import { loadGuideContent } from "../lib/knowledge";
import { guideRouter } from "./guide";

const mockedLoadGuide = vi.mocked(loadGuideContent);

function createApp() {
  const app = express();
  app.use("/api/guide", guideRouter);
  return app;
}

async function httpGet(
  app: express.Express,
  path: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Bad address"));
        return;
      }
      const req = httpRequest(
        { hostname: "127.0.0.1", port: addr.port, path, method: "GET" },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) });
          });
        }
      );
      req.on("error", (e) => {
        server.close();
        reject(e);
      });
      req.end();
    });
  });
}

describe("guide route", () => {
  beforeEach(() => {
    mockedLoadGuide.mockReset();
  });

  it("GET /api/guide returns guide content", async () => {
    mockedLoadGuide.mockResolvedValue("# SRE Investigation Techniques\n\nGuide content here");

    const app = createApp();
    const res = await httpGet(app, "/api/guide");

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("# SRE Investigation Techniques\n\nGuide content here");
  });

  it("GET /api/guide returns 500 on error", async () => {
    mockedLoadGuide.mockRejectedValue(new Error("disk failure"));

    const app = createApp();
    const res = await httpGet(app, "/api/guide");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to load guide content");
  });
});
