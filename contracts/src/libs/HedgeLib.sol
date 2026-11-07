// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice HyperCore ids the vault and the gateway agree on.
/// Orders take the asset id (HIP-3: 100000 + dex*10000 + idx); reads take the perp index (dex*10000 + idx).
library HedgeLib {
    uint32 internal constant HIP3_ASSET_OFFSET = 100_000;
    uint64 internal constant USDC_TOKEN = 0;

    /// @notice Order asset id → read perp index. Native perps use the same number for both.
    function perpIndexOf(uint32 asset) internal pure returns (uint32) {
        return asset >= HIP3_ASSET_OFFSET ? asset - HIP3_ASSET_OFFSET : asset;
    }

    /// @notice Deterministic client order id so keeper/dashboard can match fills in the info API.
    function makeCloid(bytes32 id, uint8 attempt) internal pure returns (uint128) {
        return uint128(uint256(keccak256(abi.encode(id, attempt))));
    }
}
