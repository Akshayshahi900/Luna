import { defineConfig } from "vitest/config";

// Tests use a fake chat model (test/helpers.ts): no API keys, no LLM calls.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
  },
});
