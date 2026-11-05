// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Every unit conversion lives here. Most silently-dropped CoreWriter orders are a bug in this file.
///
/// | Quantity             | Units                                                  |
/// | USDC (EVM)           | 6 dec                                                  |
/// | NVDAx                | 18 dec                                                 |
/// | Morpho oracle price  | 1e36 scaled, adjusted for token decimals               |
/// | CoreWriter px, sz    | human × 1e8, rounded to szDecimals / tick rules        |
/// | oraclePx precompile  | divide by 10^(6 − szDecimals) for perps                |
/// | szi                  | signed Core size units                                 |
library Units {
    uint256 internal constant NVDAX_DECIMALS = 18;
    uint256 internal constant USDC_DECIMALS = 6;
    uint256 internal constant CORE_WIRE_DECIMALS = 8;

    /// @notice NVDAx (18 dec) → Core size units (szDecimals), rounded down.
    function toCoreSize(uint256 nvdaxAmount, uint8 szDecimals) internal pure returns (int64) {
        return int64(uint64(nvdaxAmount / 10 ** (NVDAX_DECIMALS - szDecimals)));
    }

    /// @notice Core size units → NVDAx (18 dec).
    function fromCoreSize(int64 sz, uint8 szDecimals) internal pure returns (uint256) {
        uint64 a = sz < 0 ? uint64(-sz) : uint64(sz);
        return uint256(a) * 10 ** (NVDAX_DECIMALS - szDecimals);
    }

    /// @notice Core size units → CoreWriter wire `sz` (human × 1e8).
    function sizeToWire(uint64 sz, uint8 szDecimals) internal pure returns (uint64) {
        return sz * uint64(10 ** (CORE_WIRE_DECIMALS - szDecimals));
    }

    /// @notice oraclePx precompile (perp) → CoreWriter wire `limitPx` (human × 1e8).
    /// @dev Human px = raw / 10^(6 − szDecimals). TODO: round to 5 significant figures / tick before scaling.
    function pxToWire(uint64 rawPx, uint8 szDecimals) internal pure returns (uint64) {
        return rawPx * uint64(10 ** (CORE_WIRE_DECIMALS - (6 - szDecimals)));
    }

    /// @notice oraclePx precompile (perp) → USDC (6 dec) per 1 whole NVDAx.
    function pxToUsdc(uint64 rawPx, uint8 szDecimals) internal pure returns (uint256) {
        return uint256(rawPx) * 10 ** szDecimals;
    }

    /// @notice Morpho oracle price (1e36-scaled) → USDC (6 dec) per 1 whole NVDAx.
    function morphoPxToUsdc(uint256 morphoPx) internal pure returns (uint256) {
        // morphoPx = usdcUnits-per-nvdaxUnit × 1e36, so per 1e18 nvdax units: morphoPx × 1e18 / 1e36
        return morphoPx / 10 ** (36 - NVDAX_DECIMALS);
    }
}
