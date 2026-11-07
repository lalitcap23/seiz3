import { readFileSync } from "node:fs";
import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

// Morpho Blue's interfaces are compiled twice (0.8.19 for the real Morpho test artifact, 0.8.28 with our
// sources), so forge writes versioned artifacts. Register the 0.8.28 one under its plain name.
const iMorpho = JSON.parse(readFileSync("../../contracts/out/IMorpho.sol/IMorpho.0.8.28.json", "utf8"));

// Reads ../../contracts/out (run `pnpm contracts:build` first, or `pnpm codegen` from the root).
export default defineConfig({
  out: "src/generated/abis.ts",
  contracts: [{ name: "IMorpho", abi: iMorpho.abi }],
  plugins: [
    foundry({
      project: "../../contracts",
      forge: { build: false },
      include: [
        "RiskParams.sol/**",
        "MockNVDAx.sol/**",
        "DemoOracle.sol/**",
        "NaiveLiquidator.sol/**",
        "PoolSeeder.sol/**",
        "Faucet.sol/**",
        "PoolSwapTest.sol/**",
        // contracts/src/remote: the vault, its hook and the HyperCore gateway
        "HyperCoreGateway.sol/**",
        "Seiz3VaultRemote.sol/**",
        "Seiz3HookRemote.sol/**",
      ],
    }),
  ],
});
