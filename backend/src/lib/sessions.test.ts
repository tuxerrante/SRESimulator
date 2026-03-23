import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createSession, validateAndConsumeSession } from "./sessions";

describe("sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a session and returns a UUID token", () => {
    const token = createSession("easy", "Test Scenario");
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("validates and consumes a fresh session", () => {
    const token = createSession("medium", "Medium Scenario");
    const session = validateAndConsumeSession(token);

    expect(session).not.toBeNull();
    expect(session!.difficulty).toBe("medium");
    expect(session!.scenarioTitle).toBe("Medium Scenario");
    expect(session!.used).toBe(true);
  });

  it("rejects a second consume of the same session", () => {
    const token = createSession("hard", "Hard Scenario");
    validateAndConsumeSession(token);
    const second = validateAndConsumeSession(token);

    expect(second).toBeNull();
  });

  it("rejects an unknown token", () => {
    const result = validateAndConsumeSession("nonexistent-token");
    expect(result).toBeNull();
  });

  it("expires sessions after TTL", () => {
    const token = createSession("easy", "Old Scenario");

    vi.advanceTimersByTime(25 * 60 * 60 * 1000);

    const result = validateAndConsumeSession(token);
    expect(result).toBeNull();
  });
});
