import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

// Reads ../../contracts/out (run `pnpm contracts:build` first, or `pnpm codegen` from the root).
export default defineConfig({
  out: "src/generated/abis.ts",
  plugins: [
    foundry({
      project: "../../contracts",
      forge: { build: false },
      include: [
        "AfterbellVault.sol/**",
        "RiskParams.sol/**",
        "MockNVDAx.sol/**",
        "DemoOracle.sol/**",
        "NaiveLiquidator.sol/**",
        "IMorpho.sol/IMorpho.json",
      ],
    }),
  ],
});
