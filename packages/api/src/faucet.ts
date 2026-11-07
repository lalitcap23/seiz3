import { createWalletClient, http, isAddress, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { faucetAbi } from "@seiz3/shared/abis";

export type DripResult =
  | { ok: true; hash: Hex }
  | { ok: false; status: 400 | 429 | 503; error: string; retryAt?: number };

/**
 * Drips for testers who have no HYPE to call `Faucet.claim` themselves. The contract enforces one drip per address
 * per cooldown; this adds one per IP per `ipCooldownSec`, since new addresses are free. Drips go out one at a time so
 * the operator key never races itself for a nonce.
 */
export class FaucetRelay {
  private readonly lastByIp = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly wallet;

  constructor(
    private readonly client: PublicClient,
    chain: Chain,
    rpcUrl: string | undefined,
    operatorKey: Hex,
    private readonly faucet: Address,
    private readonly ipCooldownSec: number,
  ) {
    this.wallet = createWalletClient({ account: privateKeyToAccount(operatorKey), chain, transport: http(rpcUrl) });
  }

  drip(to: string, ip: string): Promise<DripResult> {
    const run = this.queue.then(() => this.dripNow(to, ip));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async dripNow(to: string, ip: string): Promise<DripResult> {
    if (!isAddress(to)) return { ok: false, status: 400, error: "not an address" };
    const now = Math.floor(Date.now() / 1000);
    const last = this.lastByIp.get(ip);
    if (last !== undefined && now < last + this.ipCooldownSec) {
      return { ok: false, status: 429, error: "one drip per hour from this network", retryAt: last + this.ipCooldownSec };
    }
    const next = Number(
      await this.client.readContract({ address: this.faucet, abi: faucetAbi, functionName: "nextDripAt", args: [to] }),
    );
    if (now < next) return { ok: false, status: 429, error: "this address already got its drip", retryAt: next };

    try {
      const hash = await this.wallet.writeContract({
        address: this.faucet,
        abi: faucetAbi,
        functionName: "drip",
        args: [to],
      });
      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") return { ok: false, status: 503, error: `drip reverted: ${hash}` };
      this.lastByIp.set(ip, now);
      return { ok: true, hash };
    } catch (error) {
      return { ok: false, status: 503, error: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
    }
  }
}
