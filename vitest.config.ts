import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    testTimeout: 10_000,
  },
});
