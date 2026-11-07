import {
  POLL_EXPORT_SCHEMA_VERSION,
  serializePollExport,
  type PollExport,
} from "@seiz3/shared/risk";

import type { MorphoApiSnapshot } from "./morphoApi.js";
import type { Config, ScanReport, VaultState } from "./types.js";

/**
 * Builds the single polled-data export the keeper serves on GET /snapshot.
 * The wire schema lives in @seiz3/shared/risk.
 */
export function buildPollExport(
  state: VaultState,
  scan: ScanReport,
  morphoApi: MorphoApiSnapshot | null,
  cfg: Config,
): PollExport {
  return {
    schemaVersion: POLL_EXPORT_SCHEMA_VERSION,
    ts: scan.ts,
    chainId: cfg.chainId,
    blockNumber: state.blockNumber,
    vault: state.vault,
    morpho: cfg.morpho,
    marketId: scan.marketId,
    state: {
      ...state,
      borrowers: [...state.borrowers],
    },
    scan: {
      ...scan,
      borrowers: [...scan.borrowers],
    },
    morphoApi:
      morphoApi === null
        ? null
        : {
            ...morphoApi,
            positions: [...morphoApi.positions],
          },
  };
}

export { serializePollExport };
