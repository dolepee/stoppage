import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "app/src/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
    exclude: ["dist/**", "node_modules/**"],
  },
});
