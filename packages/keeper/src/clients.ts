import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import type { Address, Config } from "./types.js";

export interface KeeperClients {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: PrivateKeyAccount;
  readonly chain: Chain;
  readonly nonces: SingleNonceManager;
}

export function makeChain(cfg: Pick<Config, "chainId" | "rpcUrl">): Chain {
  const id = Number(cfg.chainId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`unsupported chainId: ${cfg.chainId.toString()}`);
  }
  return defineChain({
    id,
    name: "seiz3",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    contracts: {
      multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
    },
  });
}

export function makeClients(cfg: Config): KeeperClients {
  const chain = makeChain(cfg);
  const account = privateKeyToAccount(cfg.keeperPrivateKey);
  const transport = http(cfg.rpcUrl, { retryCount: 2, timeout: 15_000 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 250 });
  const walletClient = createWalletClient({ account, chain, transport });
  return { publicClient, walletClient, account, chain, nonces: new SingleNonceManager() };
}

/**
 * One signer, one serialized nonce stream. The tick loop never has more than
 * one transaction in flight, so a cached pending nonce is sufficient.
 */
export class SingleNonceManager {
  private next: number | undefined;

  async consume(client: PublicClient, address: Address): Promise<number> {
    if (this.next === undefined) {
      this.next = await client.getTransactionCount({ address, blockTag: "pending" });
    }
    const nonce = this.next;
    this.next += 1;
    return nonce;
  }

  reset(): void {
    this.next = undefined;
  }

  peek(): number | undefined {
    return this.next;
  }
}
