"use client";

import { useQuery } from "@tanstack/react-query";
import { seiz3HookRemoteAbi } from "@seiz3/shared/abis";
import { dep, publicClient } from "./chain";

export interface HookQuote {
  capacity: bigint; // NVDAx (18 dec) one buy can take from the vault now
  askUsd6: bigint; // USDC (6 dec) per NVDAx the vault sells at
  fee: number; // LP fee, pips, for the part a swap sends to the curve
  open: boolean;
}

/**
 * Seiz3Hook.quote(), every 10 s, on deployments with a hook: what a buyer would get from the vault's hedged stock.
 * Null while the hook's HyperCore reads fail (the swap then just uses the curve).
 */
export function useHookQuote() {
  return useQuery({
    queryKey: ["hookQuote"],
    enabled: dep.hook !== undefined,
    refetchInterval: 10_000,
    queryFn: async (): Promise<HookQuote | null> => {
      try {
        const [capacity, askUsd6, fee, open] = await publicClient.readContract({
          address: dep.hook!,
          abi: seiz3HookRemoteAbi,
          functionName: "quote",
        });
        return { capacity, askUsd6, fee: Number(fee), open };
      } catch {
        return null;
      }
    },
  });
}
