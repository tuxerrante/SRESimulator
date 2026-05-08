import { describe, expect, it } from "vitest";
import * as bootstrapConfig from "./bootstrap-config";
import { parseReplaySampleRate, shouldInitSentry } from "./bootstrap-config";

describe("shouldInitSentry", () => {
  it.each([
    [undefined, undefined, false],
    ["false", "https://dsn.example/1", false],
    ["true", undefined, false],
    ["true", "", false],
    ["true", "https://dsn.example/1", true],
  ])("returns %s/%s => %s", (enabled, dsn, expected) => {
    expect(shouldInitSentry(enabled, dsn)).toBe(expected);
  });
});

describe("parseReplaySampleRate", () => {
  it.each([
    [undefined, 0],
    ["not-a-number", 0],
    ["-1", 0],
    ["0.25", 0.25],
    ["1.5", 1],
  ])("returns %s as %d-safe replay sample rate", (value, expected) => {
    expect(parseReplaySampleRate(value)).toBe(expected);
  });
});

describe("readFrontendSentryRuntimeConfig", () => {
  it("reads browser config from runtime env values", () => {
    expect("readFrontendSentryRuntimeConfig" in bootstrapConfig).toBe(true);

    if (!("readFrontendSentryRuntimeConfig" in bootstrapConfig)) {
      return;
    }

    const config = bootstrapConfig.readFrontendSentryRuntimeConfig({
      NEXT_PUBLIC_SENTRY_ENABLED: "true",
      NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production",
      NEXT_PUBLIC_SENTRY_RELEASE: "frontend@1.2.3",
      NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE: "0.25",
      NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE: "1",
    });

    expect(config).toEqual({
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      replaySessionSampleRate: 0.25,
      replayOnErrorSampleRate: 1,
    });
  });
});
