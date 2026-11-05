import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // shared ships TS source; Next compiles it
  transpilePackages: ["@afterbell/shared"],
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
