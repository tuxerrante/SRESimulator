import { afterEach, describe, expect, it, vi } from "vitest";
import * as helpers from "./helpers";

type ScenarioHelperModule = {
  getScenarioRequestHeaders?: () => Record<string, string>;
  getExpectedScenarioTrafficSource?: () => "player" | "automated";
  getViewerAuthCookie?: () => string | undefined;
  getGameplayAdminHeaders?: () => Record<string, string>;
};

describe("integration helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses automated scenario headers only for local targets", () => {
    vi.stubEnv("AUTOMATED_TRAFFIC_TOKEN", "local-test-token");
    vi.stubEnv("E2E_BACKEND_URL", "https://remote-backend.example");

    const scenarioHelpers = helpers as ScenarioHelperModule;

    expect(scenarioHelpers.getScenarioRequestHeaders?.()).toEqual({});
    expect(scenarioHelpers.getExpectedScenarioTrafficSource?.()).toBe("player");
  });

  it("uses automated scenario headers for local in-process targets", () => {
    vi.stubEnv("AUTOMATED_TRAFFIC_TOKEN", "local-test-token");
    vi.stubEnv("E2E_BACKEND_URL", "");

    const scenarioHelpers = helpers as ScenarioHelperModule;

    expect(scenarioHelpers.getScenarioRequestHeaders?.()).toEqual({
      "x-traffic-source": "automated",
      "x-traffic-source-token": "local-test-token",
    });
    expect(scenarioHelpers.getExpectedScenarioTrafficSource?.()).toBe("automated");
  });

  it("creates a viewer auth cookie from E2E_AUTH_SESSION_SECRET for external targets", () => {
    vi.stubEnv("E2E_BACKEND_URL", "https://example.test");
    vi.stubEnv("E2E_AUTH_SESSION_SECRET", "external-secret");

    const scenarioHelpers = helpers as ScenarioHelperModule;
    expect(scenarioHelpers.getViewerAuthCookie?.()).toMatch(/^sresim_viewer_session=/);
  });

  it("builds admin bearer headers from E2E_GAMEPLAY_ADMIN_TOKEN", () => {
    vi.stubEnv("E2E_GAMEPLAY_ADMIN_TOKEN", "admin-token");

    const scenarioHelpers = helpers as ScenarioHelperModule;
    expect(scenarioHelpers.getGameplayAdminHeaders?.()).toEqual({
      authorization: "Bearer admin-token",
    });
  });
});
