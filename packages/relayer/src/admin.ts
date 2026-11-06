// The hedge account on Hyperliquid, by hand (scripts/base-stack.sh wraps these):
//   status                 spot USDC, xyz account value and the NVDA position
//   to-xyz <usdc>          spot USDC → the xyz DEX (the short's isolated margin)
//   from-xyz <usdc>        xyz → spot
// HL_PRIVATE_KEY must be the hedge account's own key: an API wallet can trade but can't move funds.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const key = process.env.HL_PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error("set HL_PRIVATE_KEY");
const testnet = (process.env.HL_TESTNET ?? "1") !== "0" && process.env.HL_TESTNET !== "false";
const dex = process.env.HL_DEX ?? "xyz";
const coin = process.env.HL_COIN ?? "xyz:NVDA";
const wallet = privateKeyToAccount(key);
const user = (process.env.HL_ACCOUNT as Hex | undefined) ?? wallet.address;
const transport = new HttpTransport({ isTestnet: testnet });
const info = new InfoClient({ transport });

const [cmd, amount] = process.argv.slice(2);

async function status(): Promise<void> {
  const [spot, state, role] = await Promise.all([
    info.spotClearinghouseState({ user }),
    info.clearinghouseState({ user, dex }),
    info.userRole({ user }),
  ]);
  const usdc = spot.balances.find((b) => b.coin === "USDC")?.total ?? "0";
  const position = state.assetPositions.find((p) => p.position.coin === coin)?.position;
  console.log(`hedge account ${user} (${testnet ? "testnet" : "mainnet"}, role ${role.role})`);
  console.log(`  spot USDC     ${usdc}`);
  console.log(`  ${dex} value     ${state.marginSummary.accountValue} (margin used ${state.marginSummary.totalMarginUsed})`);
  console.log(`  ${coin}      ${position ? `${position.szi} @ ${position.entryPx}, uPnL ${position.unrealizedPnl}` : "flat"}`);
}

async function move(from: string, to: string): Promise<void> {
  if (!amount) throw new Error(`usage: ${cmd} <usdc>`);
  const role = await info.userRole({ user: wallet.address });
  if (role.role === "agent") throw new Error(`${wallet.address} is an API wallet: moving funds needs the account's own key`);
  const usdc = (await info.spotMeta()).tokens.find((t) => t.name === "USDC");
  if (!usdc) throw new Error("no USDC in spotMeta");
  await new ExchangeClient({ transport, wallet }).sendAsset({
    destination: wallet.address,
    sourceDex: from,
    destinationDex: to,
    token: `USDC:${usdc.tokenId}`,
    amount,
  });
  console.log(`moved ${amount} USDC ${from || "perp"} → ${to || "perp"}`);
  await status();
}

/** What the relayer would post to the gateway right now (read-only: nothing is signed or sent). */
async function snapshot(): Promise<void> {
  const { HyperliquidBackend } = await import("./hyperliquid.js");
  const backend = new HyperliquidBackend(key!, user, { testnet, dex, coin, szDecimals: Number(process.env.SZ_DECIMALS ?? 3) });
  const s = await backend.snapshot();
  console.log(JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

/**
 * agent-send <destination> <usdc> [destinationDex]: an API wallet (HL_PRIVATE_KEY) moves its principal's (HL_ACCOUNT)
 * spot USDC to another address, onto its spot balance or straight onto a perp DEX ("xyz"). Funds a fresh hedge or
 * market-maker wallet from an account we only hold an agent key for.
 */
async function agentSend(): Promise<void> {
  const [, destination, usdcAmount, destinationDex = "spot"] = process.argv.slice(2);
  if (!destination || !usdcAmount) throw new Error("usage: agent-send <destination> <usdc> [destinationDex]");
  const role = await info.userRole({ user: wallet.address });
  if (role.role !== "agent" || role.data.user.toLowerCase() !== user.toLowerCase()) {
    throw new Error(`${wallet.address} is not an API wallet of ${user} (role ${role.role})`);
  }
  const usdc = (await info.spotMeta()).tokens.find((t) => t.name === "USDC");
  if (!usdc) throw new Error("no USDC in spotMeta");
  const res = await new ExchangeClient({ transport, wallet }).agentSendAsset({
    destination: destination as Hex,
    sourceDex: "spot",
    destinationDex,
    token: `USDC:${usdc.tokenId}`,
    amount: usdcAmount,
  });
  console.log(`agent ${wallet.address} sent ${usdcAmount} USDC from ${user} (spot) → ${destination} (${destinationDex}):`, JSON.stringify(res));
}

/** sub-account <name>: an API wallet (HL_PRIVATE_KEY) creates a sub-account of its principal (HL_ACCOUNT). */
async function subAccount(): Promise<void> {
  const name = process.argv[3];
  if (!name) throw new Error("usage: sub-account <name>");
  const res = await new ExchangeClient({ transport, wallet }).createSubAccount({ name });
  console.log(`sub-account "${name}" of ${user}:`, JSON.stringify(res));
  console.log(JSON.stringify(await info.subAccounts({ user }), null, 2));
}

/** cancel-all: cancel every open order of the account on the perp DEX (e.g. a market maker's quotes after it stops). */
async function cancelAll(): Promise<void> {
  const open = (await info.openOrders({ user, dex })).filter((o) => o.coin === coin);
  if (open.length === 0) {
    console.log(`${user}: no open ${coin} orders`);
    return;
  }
  const [meta] = await info.metaAndAssetCtxs({ dex });
  const index = meta.universe.findIndex((u) => u.name === coin);
  const perpDexs = await info.perpDexs();
  const dexIndex = perpDexs.findIndex((d) => d?.name === dex);
  const asset = 100_000 + dexIndex * 10_000 + index; // HIP-3 asset id
  await new ExchangeClient({ transport, wallet }).cancel({ cancels: open.map((o) => ({ a: asset, o: o.oid })) });
  console.log(`${user}: cancelled ${open.length} ${coin} order(s): ${open.map((o) => `${o.side} ${o.sz} @ ${o.limitPx}`).join(", ")}`);
}

if (cmd === "status") await status();
else if (cmd === "cancel-all") await cancelAll();
else if (cmd === "sub-account") await subAccount();
else if (cmd === "snapshot") await snapshot();
else if (cmd === "agent-send") await agentSend();
else if (cmd === "to-xyz") await move("spot", dex);
else if (cmd === "from-xyz") await move(dex, "spot");
else {
  console.error("usage: admin status | to-xyz <usdc> | from-xyz <usdc>");
  process.exit(1);
}
