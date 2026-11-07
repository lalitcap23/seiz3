import {
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  seiz3HookRemoteAbi,
  seiz3VaultRemoteAbi,
  demoOracleAbi,
  faucetAbi,
  iMorphoAbi,
  naiveLiquidatorAbi,
  poolSeederAbi,
  poolSwapTestAbi,
  riskParamsAbi,
} from "@seiz3/shared/abis";
import type { DeploymentFile } from "@seiz3/shared/node";

/** Everything the web's /tx/<hash> page shows: the decoded call and events, plus the vault's HyperCore orders. */
export interface TxView {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: string;
  timestamp: number;
  from: Address;
  to: Address | null;
  toName: string | null;
  call: { name: string; args: unknown } | null;
  gasUsed: string;
  events: { address: Address; contract: string | null; name: string; args: Record<string, unknown> }[];
  /** The vault's HyperCore orders this tx sent (HedgeSent), with what HyperCore did with each. */
  hypercore: {
    cloid: Hex;
    side: "sell" | "buy";
    size: string;
    status: string;
    /** `hash` is HyperCore's own: Hyperliquid's explorer opens it at hypercoreTxExplorer + hash. */
    fills: { sz: string; px: string; time: number; hash: string }[];
  }[];
  hypercoreExplorer: string | null;
  hypercoreTxExplorer: string | null;
}

/** Morpho Blue's EventsLib: IMorpho doesn't declare its events. */
const morphoEventsAbi = parseAbi([
  "event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)",
  "event Withdraw(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
  "event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)",
  "event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)",
  "event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)",
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
  "event AccrueInterest(bytes32 indexed id, uint256 prevBorrowRate, uint256 interest, uint256 feeShares)",
]);

const ABIS: Abi[] = [
  seiz3VaultRemoteAbi,
  seiz3HookRemoteAbi,
  morphoEventsAbi,
  iMorphoAbi,
  naiveLiquidatorAbi,
  faucetAbi,
  poolSeederAbi,
  poolSwapTestAbi,
  demoOracleAbi,
  riskParamsAbi,
  erc20Abi,
];

/** What the deployment's addresses are, for "to: Seiz3 vault" instead of a bare hex. */
function names(dep: DeploymentFile): Map<string, { name: string; abi: Abi }> {
  const m = new Map<string, { name: string; abi: Abi }>();
  const add = (a: string | undefined, name: string, abi: Abi) => a && m.set(a.toLowerCase(), { name, abi });
  add(dep.vault, "Seiz3 vault", seiz3VaultRemoteAbi);
  add(dep.hook, "Seiz3 hook (v4)", seiz3HookRemoteAbi);
  add(dep.morpho, "Morpho Blue", [...iMorphoAbi, ...morphoEventsAbi]);
  add(dep.naiveLiquidator, "NaiveLiquidator (market A)", naiveLiquidatorAbi);
  add(dep.faucet, "Faucet", faucetAbi);
  add(dep.poolSeeder, "PoolSeeder", poolSeederAbi);
  add(dep.swapRouter, "Swap router (PoolSwapTest)", poolSwapTestAbi);
  add(dep.riskParams, "RiskParams", riskParamsAbi);
  add(dep.usdc, "USDC", erc20Abi);
  add(dep.nvdax, "NVDAx", erc20Abi);
  add(dep.poolManager, "Uniswap v4 PoolManager", []);
  for (const [k, v] of Object.entries(dep.markets)) add(v.oracle, `${k} oracle`, demoOracleAbi);
  return m;
}

/** bigints → strings, so the view goes out as JSON. */
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

interface HlOrderStatus {
  status: string;
  order?: { status: string; order: { oid: number } };
}

export async function readTx(
  client: PublicClient,
  dep: DeploymentFile,
  hash: Hex,
  hl: { infoUrl: string | null; explorer: string | null; txExplorer: string | null },
): Promise<TxView | null> {
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash }).catch(() => null),
    client.getTransactionReceipt({ hash }).catch(() => null),
  ]);
  if (tx === null || receipt === null) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const known = names(dep);
  const target = tx.to ? known.get(tx.to.toLowerCase()) : undefined;

  let call: TxView["call"] = null;
  if (target && target.abi.length > 0) {
    try {
      const d = decodeFunctionData({ abi: target.abi, data: tx.input });
      call = { name: d.functionName, args: plain(d.args ?? []) };
    } catch {
      call = null;
    }
  }

  const events: TxView["events"] = [];
  for (const log of receipt.logs) {
    const owner = known.get(log.address.toLowerCase());
    for (const abi of owner && owner.abi.length > 0 ? [owner.abi, ...ABIS] : ABIS) {
      try {
        const e = decodeEventLog({ abi, data: log.data, topics: log.topics });
        events.push({
          address: log.address,
          contract: owner?.name ?? null,
          name: e.eventName ?? "?",
          args: plain(e.args ?? {}) as Record<string, unknown>,
        });
        break;
      } catch {
        // not this ABI
      }
    }
  }

  const hypercore: TxView["hypercore"] = [];
  const sent = events.filter((e) => e.name === "HedgeSent" && e.address.toLowerCase() === dep.vault.toLowerCase());
  if (hl.infoUrl && sent.length > 0) {
    const post = async <T>(body: Record<string, unknown>) =>
      (await (await fetch(hl.infoUrl as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })).json()) as T;
    const fills = await post<{ oid: number; sz: string; px: string; time: number; hash: string }[]>({
      type: "userFills",
      user: dep.hedgeAccount ?? dep.vault,
    });
    for (const e of sent) {
      const cloid = toHex(BigInt(String(e.args.cloid)), { size: 16 });
      const delta = BigInt(String(e.args.delta));
      const st = await post<HlOrderStatus>({ type: "orderStatus", user: dep.hedgeAccount ?? dep.vault, oid: cloid }).catch(() => null);
      const oid = st?.order?.order.oid;
      hypercore.push({
        cloid,
        side: delta < 0n ? "sell" : "buy",
        size: (Number(delta < 0n ? -delta : delta) / 10 ** dep.hypercore.szDecimals).toString(),
        status: st?.order?.status ?? st?.status ?? "unknown",
        fills:
          oid === undefined
            ? []
            : fills.filter((f) => f.oid === oid).map((f) => ({ sz: f.sz, px: f.px, time: f.time, hash: f.hash })),
      });
    }
  }

  return {
    hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    timestamp: Number(block.timestamp) * 1000,
    from: tx.from,
    to: tx.to ?? null,
    toName: target?.name ?? null,
    call,
    gasUsed: receipt.gasUsed.toString(),
    events,
    hypercore,
    hypercoreExplorer: hl.explorer,
    hypercoreTxExplorer: hl.txExplorer,
  };
}
