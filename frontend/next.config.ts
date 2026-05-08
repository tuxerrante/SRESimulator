import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  experimental: {
    externalDir: true,
  },
};

const hasSentrySourceMapUploadConfig = Boolean(
  process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT,
);

export default withSentryConfig(nextConfig, {
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  release: process.env.SENTRY_RELEASE
    ? {
        name: process.env.SENTRY_RELEASE,
      }
    : undefined,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: {
    disable: !hasSentrySourceMapUploadConfig,
  },
});
