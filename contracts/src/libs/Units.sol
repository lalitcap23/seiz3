// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Every unit conversion lives here. Most silently-dropped CoreWriter orders are a bug in this file.
///
/// | Quantity             | Units                                                  |
/// | USDC (EVM)           | 6 dec                                                  |
/// | NVDAx                | 18 dec                                                 |
/// | Morpho oracle price  | 1e36 scaled, adjusted for token decimals               |
/// | CoreWriter px, sz    | human × 1e8, rounded to szDecimals / tick rules        |
/// | oraclePx precompile  | divide by 10^(6 − szDecimals) for perps ("raw px")     |
/// | szi                  | signed Core size units (human × 10^szDecimals)         |
/// | Core perp USD        | 6 dec (margin summary, entry notional)                 |
/// | Core spot USDC       | 8 dec wei                                              |
library Units {
    uint256 internal constant NVDAX_DECIMALS = 18;
    uint256 internal constant USDC_DECIMALS = 6;
    uint256 internal constant CORE_WIRE_DECIMALS = 8;
    uint256 internal constant PERP_PX_DECIMALS = 6; // raw perp px has (6 − szDecimals) decimals
    uint256 internal constant MAX_SIG_FIGS = 5;
    uint256 internal constant SPOT_WEI_PER_USDC = 100; // Core spot wei (8 dec) per EVM USDC unit (6 dec)
    uint256 internal constant BPS = 10_000;

    error SizeOverflow();
    error BadSzDecimals();

    // ─── sizes ────────────────────────────────────────────────────────────

    /// @notice NVDAx (18 dec) → Core size units (szDecimals), rounded down.
    function toCoreSize(uint256 nvdaxAmount, uint8 szDecimals) internal pure returns (uint64) {
        uint256 sz = nvdaxAmount / 10 ** (NVDAX_DECIMALS - szDecimals);
        if (sz > uint64(type(int64).max)) revert SizeOverflow(); // must stay negatable as an int64 szi
        return uint64(sz);
    }

    /// @notice Core size units → NVDAx (18 dec).
    function fromCoreSize(uint64 sz, uint8 szDecimals) internal pure returns (uint256) {
        return uint256(sz) * 10 ** (NVDAX_DECIMALS - szDecimals);
    }

    /// @notice Core size units → CoreWriter wire `sz` (human × 1e8). Exact, so always on the size grid.
    function sizeToWire(uint64 sz, uint8 szDecimals) internal pure returns (uint64) {
        return sz * uint64(10 ** (CORE_WIRE_DECIMALS - szDecimals));
    }

    // ─── prices ───────────────────────────────────────────────────────────

    /// @notice Raw perp px (oraclePx precompile) → CoreWriter wire `limitPx` (human × 1e8).
    /// @dev human = raw / 10^(6 − szDecimals), wire = human × 1e8 = raw × 10^(2 + szDecimals).
    function pxToWire(uint64 rawPx, uint8 szDecimals) internal pure returns (uint64) {
        return rawPx * uint64(10 ** (CORE_WIRE_DECIMALS - PERP_PX_DECIMALS + szDecimals));
    }

    /// @notice Raw perp px → USDC (6 dec) per 1 whole NVDAx.
    function pxToUsdc(uint64 rawPx, uint8 szDecimals) internal pure returns (uint256) {
        return uint256(rawPx) * 10 ** szDecimals;
    }

    /// @notice Morpho oracle price (1e36-scaled, USDC units per NVDAx unit) → USDC (6 dec) per 1 whole NVDAx.
    function morphoPxToUsdc(uint256 morphoPx) internal pure returns (uint256) {
        return morphoPx / 10 ** (36 - NVDAX_DECIMALS);
    }

    /// @notice Round a raw perp px to Hyperliquid's tick rules: at most 5 significant figures, at most
    ///         (6 − szDecimals) decimals. Integer prices are always valid, so the step never exceeds 1.0.
    /// @param up round away from zero (buy caps) instead of toward zero (sell floors)
    function roundPx(uint64 rawPx, uint8 szDecimals, bool up) internal pure returns (uint64) {
        if (szDecimals > PERP_PX_DECIMALS) revert BadSzDecimals();
        uint256 digits;
        for (uint256 v = rawPx; v != 0; v /= 10) {
            ++digits;
        }
        if (digits <= MAX_SIG_FIGS) return rawPx;

        uint256 step = 10 ** (digits - MAX_SIG_FIGS);
        uint256 wholeUnit = 10 ** (PERP_PX_DECIMALS - szDecimals);
        if (step > wholeUnit) step = wholeUnit;

        uint256 down = (rawPx / step) * step;
        if (!up || down == rawPx) return uint64(down);
        return uint64(down + step);
    }

    /// @notice Price `bps` away from `rawPx`, tick-rounded so the order stays at least as aggressive as asked.
    /// @param above true for a buy cap (px × (1 + bps)), false for a sell floor (px × (1 − bps))
    function offsetPx(uint64 rawPx, uint16 bps, bool above, uint8 szDecimals) internal pure returns (uint64) {
        uint256 shifted = above ? uint256(rawPx) * (BPS + bps) / BPS : uint256(rawPx) * (BPS - bps) / BPS;
        return roundPx(uint64(shifted), szDecimals, above);
    }

    // ─── money ────────────────────────────────────────────────────────────

    /// @notice NVDAx amount × (USDC per whole NVDAx) → USDC (6 dec), rounded down.
    function value(uint256 nvdaxAmount, uint256 usdcPerNvdax) internal pure returns (uint256) {
        return nvdaxAmount * usdcPerNvdax / 10 ** NVDAX_DECIMALS;
    }

    /// @notice Core spot USDC wei (8 dec) → EVM USDC (6 dec).
    function spotWeiToUsdc(uint64 amountWei) internal pure returns (uint256) {
        return amountWei / SPOT_WEI_PER_USDC;
    }

    /// @notice EVM USDC (6 dec) → Core spot USDC wei (8 dec), the unit `sendAsset` and `spotSend` take.
    function usdcToSpotWei(uint256 usdcAmount) internal pure returns (uint64) {
        uint256 amountWei = usdcAmount * SPOT_WEI_PER_USDC;
        if (amountWei > type(uint64).max) revert SizeOverflow();
        return uint64(amountWei);
    }

    /// @notice |a − b| / b in bps. Used for every "two prices must agree" band check.
    function diffBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) return type(uint256).max;
        uint256 d = a > b ? a - b : b - a;
        return d * BPS / b;
    }
}
