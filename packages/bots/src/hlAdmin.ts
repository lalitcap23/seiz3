// The HyperCore actions a testnet deploy needs, signed with the keys scripts/testnet-stack.sh exports from .env.local:
//   big-blocks on|off         DEPLOYER_PRIVATE_KEY's HyperEVM txs into 30M-gas blocks (the vault doesn't fit in 3M)
//   send-usdc <to> <amount>   HL_FUNDER_PRIVATE_KEY (else HL_MM_PRIVATE_KEY) sends spot USDC on HyperCore: creates and
//                             funds the vault's account, since testnet's CoreDepositWallet never credits HyperCore. It
//                             must be the wallet that holds the USDC: an API (agent) wallet can trade but not transfer
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const transport = new HttpTransport({ isTestnet: process.env.NETWORK !== "mainnet" });

const info = new InfoClient({ transport });

function account(...names: string[]) {
  const pk = names.map((n) => process.env[n]).find(Boolean);
  if (!pk) throw new Error(`set ${names.join(" or ")}`);
  return privateKeyToAccount(pk as Hex);
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "big-blocks" && (args[0] === "on" || args[0] === "off")) {
  const wallet = account("DEPLOYER_PRIVATE_KEY");
  await new ExchangeClient({ transport, wallet }).evmUserModify({ usingBigBlocks: args[0] === "on" });
  console.log(`big blocks ${args[0]}`);
} else if (cmd === "send-usdc" && args.length === 2) {
  const [destination, amount] = args as [Hex, string];
  const wallet = account("HL_FUNDER_PRIVATE_KEY", "HL_MM_PRIVATE_KEY");
  const role = await info.userRole({ user: wallet.address });
  if (role.role === "agent") {
    console.error(
      `${wallet.address} is an API wallet of ${role.data.user}: it can't send funds. ` +
        `Set HL_FUNDER_PRIVATE_KEY to the wallet holding the USDC, or Send ${amount} USDC (spot) to ${destination} ` +
        `on app.hyperliquid-testnet.xyz.`,
    );
    process.exit(1);
  }
  const usdc = (await info.spotMeta()).tokens.find((t) => t.name === "USDC");
  if (!usdc) throw new Error("no USDC in spotMeta");
  await new ExchangeClient({ transport, wallet }).spotSend({ destination, token: `USDC:${usdc.tokenId}`, amount });
  console.log(`sent ${amount} USDC to ${destination} on HyperCore`);
} else {
  console.error("usage: hlAdmin big-blocks on|off | send-usdc <to> <amount>");
  process.exit(1);
}
