import { describe, expect, it, beforeEach, afterEach } from "vitest";
import express from "express";
import { commandRouter } from "./command";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/command", commandRouter);
  return app;
}

async function postJson(
  app: express.Express,
  path: string,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
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
              body: JSON.parse(data),
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

describe("POST /api/command", () => {
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

  it("returns mock oc output in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "oc get nodes",
      type: "oc",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
    expect(res.body.output).toContain("master-0");
    expect(res.body.output).toContain("mock command received: oc get nodes");
  });

  it("returns mock kql output in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "ClusterLogs | take 10",
      type: "kql",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain("TimeGenerated");
  });

  it("returns mock geneva output in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "show dashboard",
      type: "geneva",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain("Dashboard: Mock Geneva View");
  });

  it("rejects invalid command type", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "test",
      type: "invalid",
      scenario: null,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid command type");
  });

  it("accepts commandHistory field without error", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "oc get nodes",
      type: "oc",
      scenario: null,
      commandHistory: [
        { command: "oc get pods", output: "NAME  READY  STATUS\npod-1  1/1  Running", type: "oc" },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
  });

  it("returns describe output for oc describe node in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "oc describe node master-0",
      type: "oc",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain("Name:");
    expect(res.body.output).toContain("Conditions:");
    expect(res.body.output).toContain("master-0");
  });

  it("returns delete confirmation for oc delete in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "oc delete machine aro-worker-0",
      type: "oc",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.output).toBe('machine "aro-worker-0" deleted');
  });

  it("handles commandHistory with null/malformed entries without crashing", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "oc get nodes",
      type: "oc",
      scenario: null,
      commandHistory: [
        null,
        { command: 123, output: null, type: "oc" },
        { command: "oc get pods", output: "Running", type: "oc" },
        "not-an-object",
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
  });

  it("handles commandHistory that is not an array", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "oc get nodes",
      type: "oc",
      scenario: null,
      commandHistory: "invalid",
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
  });
});
