import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// @seiz3/shared bundles testnet.json and mainnet.json; the Base Sepolia deployment (deployments/ is git-ignored
// apart from those two) reaches the browser here, read once at build / dev start
const env: Record<string, string> = {};
if (process.env.NEXT_PUBLIC_NETWORK === "base-sepolia") {
  env.NEXT_PUBLIC_DEPLOYMENT_JSON = readFileSync(
    process.env.DEPLOYMENTS_PATH ?? join(process.cwd(), "../../deployments/base-sepolia.json"),
    "utf8",
  );
}

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
