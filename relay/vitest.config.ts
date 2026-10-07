import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // node:sqlite prints an ExperimentalWarning on Node 22; keep test output clean.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
