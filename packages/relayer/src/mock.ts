import {
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodePacked,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

import type { CoreState, GatewayOrder, HyperCoreBackend, PlaceResult } from "./types.js";
import { abs } from "./units.js";

/** MockHyperCore's own interface (contracts/test/utils/MockHyperCore.sol). */
export const mockHyperCoreAbi = parseAbi([
  "function enqueue(address sender, bytes raw)",
  "function processBlock()",
  "function szi(address) view returns (int64)",
  "function entryNtl(address) view returns (uint64)",
  "function accountValue(address) view returns (uint256)",
  "function spotWei(address) view returns (uint64)",
  "function exists(address) view returns (bool)",
  "function oraclePx() view returns (uint64)",
  "function markPx() view returns (uint64)",
  "function leverage() view returns (uint32)",
  "function orderCount() view returns (uint256)",
  "function order(uint256 i) view returns ((address sender, uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, bool reduceOnly, uint8 tif, uint128 cloid, uint64 filled))",
  "function setPx(uint64 px)",
]);

/** CoreWriter's address: MockHyperCore only takes actions from it, so the relayer impersonates it on anvil. */
const CORE_WRITER: Address = "0x3333333333333333333333333333333333333333";
const LIMIT_ORDER_ACTION = 1;

/**
 * HyperCore on a local anvil: MockHyperCore at an ordinary address (RemoteInfra.s.sol). The relayer hands it the
 * vault's order from the hedge account, as CoreWriter would, ends HyperCore's block and reads the account back.
 * Nothing on the chain the vault lives on is made to look like HyperEVM.
 */
export class MockBackend implements HyperCoreBackend {
  readonly name = "mock";
  private impersonating = false;
  private readonly placed = new Set<bigint>();

  constructor(
    private readonly client: PublicClient,
    private readonly chain: Chain,
    private readonly rpcUrl: string,
    private readonly signer: PrivateKeyAccount,
    private readonly core: Address,
    readonly account: Address,
    private readonly szDecimals: number,
  ) {}

  async snapshot(): Promise<CoreState> {
    const read = <T>(functionName: string, args: readonly unknown[] = []) =>
      this.client.readContract({ address: this.core, abi: mockHyperCoreAbi, functionName, args } as never) as Promise<T>;
    const [block, szi, entryNtl, value, spot, exists, oraclePx, markPx, leverage] = await Promise.all([
      this.client.getBlock(),
      read<bigint>("szi", [this.account]),
      read<bigint>("entryNtl", [this.account]),
      read<bigint>("accountValue", [this.account]),
      read<bigint>("spotWei", [this.account]),
      read<boolean>("exists", [this.account]),
      read<bigint>("oraclePx"),
      read<bigint>("markPx"),
      read<number>("leverage"),
    ]);
    const ntl = abs(szi) * markPx;
    return {
      observedAt: block.timestamp,
      szi,
      entryNtl,
      accountValue: value,
      marginUsed: leverage > 0 ? ntl / BigInt(leverage) : 0n,
      ntlPos: ntl,
      spotUsdcWei: spot,
      oraclePx,
      markPx,
      leverage,
      exists,
    };
  }

  async place(o: GatewayOrder): Promise<PlaceResult> {
    if (this.placed.has(o.cloid)) return { status: "duplicate" };
    await this.impersonate();
    const raw = encodePacked(
      ["uint8", "uint24", "bytes"],
      [
        1,
        LIMIT_ORDER_ACTION,
        encodeAbiParameters(
          [
            { type: "uint32" },
            { type: "bool" },
            { type: "uint64" },
            { type: "uint64" },
            { type: "bool" },
            { type: "uint8" },
            { type: "uint128" },
          ],
          [o.asset, o.isBuy, o.limitPx, o.sz, o.reduceOnly, o.tif, o.cloid],
        ),
      ],
    );
    const coreWriter = createWalletClient({ account: CORE_WRITER, chain: this.chain, transport: http(this.rpcUrl) });
    const signer = createWalletClient({ account: this.signer, chain: this.chain, transport: http(this.rpcUrl) });
    const count = (await this.client.readContract({
      address: this.core,
      abi: mockHyperCoreAbi,
      functionName: "orderCount",
    })) as bigint;
    const enqueue = await coreWriter.writeContract({
      address: this.core,
      abi: mockHyperCoreAbi,
      functionName: "enqueue",
      args: [this.account, raw],
    });
    await this.client.waitForTransactionReceipt({ hash: enqueue });
    // fixed gas: each action runs in try/catch, so an estimate could starve it into a silent drop
    const processed = await signer.writeContract({
      address: this.core,
      abi: mockHyperCoreAbi,
      functionName: "processBlock",
      gas: 5_000_000n,
    });
    await this.client.waitForTransactionReceipt({ hash: processed });
    this.placed.add(o.cloid);

    const after = (await this.client.readContract({
      address: this.core,
      abi: mockHyperCoreAbi,
      functionName: "orderCount",
    })) as bigint;
    if (after <= count) return { status: "rejected", reason: "dropped by MockHyperCore (no account / unsupported)" };
    const placed = (await this.client.readContract({
      address: this.core,
      abi: mockHyperCoreAbi,
      functionName: "order",
      args: [after - 1n],
    })) as { filled: bigint; sz: bigint };
    const step = 10n ** BigInt(8 - this.szDecimals); // one Core size unit in wire units
    if (placed.filled === 0n) return { status: "rejected", reason: "no fill (off grid, no cross, or no margin)" };
    const size = String(placed.filled);
    return placed.filled * step < placed.sz ? { status: "partial", size, avgPx: "mark" } : { status: "filled", size, avgPx: "mark" };
  }

  private async impersonate(): Promise<void> {
    if (this.impersonating) return;
    const test = createTestClient({ mode: "anvil", chain: this.chain, transport: http(this.rpcUrl) });
    await test.impersonateAccount({ address: CORE_WRITER });
    await test.setBalance({ address: CORE_WRITER, value: parseEther("10") });
    this.impersonating = true;
  }
}
