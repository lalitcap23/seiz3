// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CoreWriterLib} from "@hyper-evm-lib/src/CoreWriterLib.sol";
import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";

/// @notice Thin wrapper over hyper-evm-lib for the vault's HyperCore account.
/// Gotchas:
///  - sendRawAction never reverts on a bad order; always confirm with a read in a LATER block.
///  - precompiles show state as of block build; you can't see your own CoreWriter action in-tx.
///  - a precompile call with a bad asset id eats all gas given; PrecompileLib reverts on failure.
library HedgeLib {
    // ─── writes (CoreWriter) ──────────────────────────────────────────────

    /// @param px  wire price (human × 1e8), already rounded to tick
    /// @param sz  wire size  (human × 1e8), already rounded to szDecimals
    function limitOrderIoc(uint32 asset, bool isBuy, uint64 px, uint64 sz, bool reduceOnly, uint128 cloid) internal {
        CoreWriterLib.placeLimitOrder(asset, isBuy, px, sz, reduceOnly, HLConstants.LIMIT_ORDER_TIF_IOC, cloid);
    }

    /// @notice Action 7: move USDC between spot and perp balances.
    function usdClassTransfer(uint64 ntl, bool toPerp) internal {
        CoreWriterLib.transferUsdClass(ntl, toPerp);
    }

    /// @notice Action 13: move USDC between perp DEXs (e.g. main → xyz isolated). VERIFY: open question 2.
    function sendAssetToDex(address self, uint32 srcDex, uint32 dstDex, uint64 token, uint64 amountWei) internal {
        CoreWriterLib.sendAsset(self, address(0), srcDex, dstDex, token, amountWei);
    }

    /// @notice Action 6: Core → EVM. Arrival is async; track it in `inTransit`.
    function spotSendToEvm(address systemAddress, uint64 token, uint64 amountWei) internal {
        CoreWriterLib.spotSend(systemAddress, token, amountWei);
    }

    // ─── reads (precompiles) ──────────────────────────────────────────────

    function position(address self, uint32 asset) internal view returns (int64 szi) {
        return PrecompileLib.position(self, asset).szi;
    }

    function oraclePx(uint32 asset) internal view returns (uint64) {
        return PrecompileLib.oraclePx(asset);
    }

    function szDecimals(uint32 asset) internal view returns (uint8) {
        return PrecompileLib.perpAssetInfo(asset).szDecimals;
    }

    function marginSummary(uint32 dexIndex, address self)
        internal
        view
        returns (PrecompileLib.AccountMarginSummary memory)
    {
        return PrecompileLib.accountMarginSummary(dexIndex, self);
    }

    function coreUserExists(address self) internal view returns (bool) {
        return PrecompileLib.coreUserExists(self);
    }

    /// @notice Deterministic client order id so keeper/dashboard can match fills in the info API.
    function makeCloid(bytes32 id, uint8 attempt) internal pure returns (uint128) {
        return uint128(uint256(keccak256(abi.encode(id, attempt))));
    }
}
