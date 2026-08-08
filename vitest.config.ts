import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    exclude: [...configDefaults.exclude, "tests/integration/**"],
    restoreMocks: true,
    setupFiles: ["./tests/setup.ts"],
    unstubGlobals: true,
  },
});
