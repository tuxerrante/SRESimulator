import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/integration/**"],
    coverage: {
      provider: "v8",
      reportsDirectory: process.env.VITEST_COVERAGE_DIR ?? "coverage",
      reporter: ["text", "json-summary", "lcov"],
    },
  },
});
