import {
  POLL_EXPORT_SCHEMA_VERSION,
  parsePollExport,
  serializePollExport,
  type PollExport,
} from "@afterbell/shared/risk";

import type { MorphoApiSnapshot } from "./morphoApi.js";
import type { Config, ScanReport, VaultState } from "./types.js";

/**
 * Builds the single polled-data export the keeper serves on GET /snapshot.
 *
 * The wire schema lives in @afterbell/shared/risk so a future risk engine
 * (outside this package) imports the same contract instead of copying it.
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

export { POLL_EXPORT_SCHEMA_VERSION, parsePollExport, serializePollExport };
export type { PollExport };
