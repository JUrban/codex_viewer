import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.integration.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
