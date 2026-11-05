import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 30_000,
    reporters: ["default"],
  },
});
