import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@web2ai/schema": `${root}packages/schema/src/index.ts`,
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      include: ["packages/schema/src/**", "apps/chrome-extension/src/lib/**"],
      reporter: ["text", "lcov"],
    },
  },
});
