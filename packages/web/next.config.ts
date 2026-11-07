import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// The Base Sepolia deployment (deployments/ is git-ignored) reaches the browser here, read once at build / dev start
const env: Record<string, string> = {
  NEXT_PUBLIC_DEPLOYMENT_JSON: readFileSync(
    process.env.DEPLOYMENTS_PATH ?? join(process.cwd(), "../../deployments/base-sepolia.json"),
    "utf8",
  ),
};

const nextConfig: NextConfig = {
  env,
  // shared ships TS source; Next compiles it
  transpilePackages: ["@seiz3/shared"],
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
