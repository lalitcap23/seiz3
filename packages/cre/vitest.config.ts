import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // the CRE SDK's test utilities import `bun:test`; alias it to vitest
      "bun:test": fileURLToPath(new URL("./test/bun-test-shim.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist", "test/bun-test-shim.ts"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // the CRE SDK ships extensionless ESM imports; bundle it with esbuild instead of
    // letting Node's loader resolve it directly
    server: {
      deps: {
        inline: ["@chainlink/cre-sdk"],
      },
    },
  },
});
