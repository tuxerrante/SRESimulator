import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
