// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Units} from "../../src/libs/Units.sol";

contract UnitsHarness {
    function toCoreSize(uint256 a, uint8 d) external pure returns (uint64) {
        return Units.toCoreSize(a, d);
    }

    function roundPx(uint64 px, uint8 d, bool up) external pure returns (uint64) {
        return Units.roundPx(px, d, up);
    }
}

contract UnitsTest is Test {
    UnitsHarness h = new UnitsHarness();

    // ─── sizes ────────────────────────────────────────────────────────────

    function test_toCoreSize_roundsDown() public pure {
        // 1.234567 NVDAx with szDecimals = 3 → 1234
        assertEq(Units.toCoreSize(1.234567e18, 3), 1234);
        assertEq(Units.toCoreSize(0.000999e18, 3), 0);
    }

    function test_toCoreSize_revertsPastInt64() public {
        vm.expectRevert(Units.SizeOverflow.selector);
        h.toCoreSize(uint256(uint64(type(int64).max)) * 1e15 + 1e15, 3);
    }

    function test_coreSize_roundTrip() public pure {
        assertEq(Units.fromCoreSize(1234, 3), 1.234e18);
    }

    function test_sizeToWire() public pure {
        // 1.234 (sz 1234 @ 3 dec) → 1.234e8
        assertEq(Units.sizeToWire(1234, 3), 123_400_000);
        assertEq(Units.sizeToWire(5, 0), 5e8);
    }

    function testFuzz_coreSize_roundTrip(uint64 sz, uint8 szDec) public pure {
        szDec = uint8(bound(szDec, 0, 6));
        sz = uint64(bound(sz, 0, uint64(type(int64).max) / 10 ** 12));
        uint256 amt = Units.fromCoreSize(sz, szDec);
        assertEq(Units.toCoreSize(amt, szDec), sz);
    }

    function testFuzz_wireSize_isOnTheGrid(uint64 sz, uint8 szDec) public pure {
        szDec = uint8(bound(szDec, 0, 6));
        sz = uint64(bound(sz, 1, 1e9));
        assertEq(Units.sizeToWire(sz, szDec) % 10 ** (8 - szDec), 0);
    }

    // ─── prices ───────────────────────────────────────────────────────────

    function test_pxToWire() public pure {
        // szDecimals 3 → raw px has 3 decimals; 180.500 = 180500 → 180.5e8
        assertEq(Units.pxToWire(180_500, 3), 18_050_000_000);
        // szDecimals 4 (xyz:XYZ100) → 2 decimals; 29574.00 = 2957400
        assertEq(Units.pxToWire(2_957_400, 4), 2_957_400_000_000);
    }

    function test_pxToUsdc() public pure {
        assertEq(Units.pxToUsdc(180_500, 3), 180.5e6);
        assertEq(Units.pxToUsdc(2_957_400, 4), 29_574e6);
    }

    function test_morphoPxToUsdc() public pure {
        // $180.5 → 180.5e6 × 1e18 (= 1e36 × 6dec / 18dec)
        assertEq(Units.morphoPxToUsdc(180.5e6 * 1e18), 180.5e6);
    }

    function test_roundPx_fiveSignificantFigures() public pure {
        assertEq(Units.roundPx(217_153, 3, false), 217_150); // 217.153 → 217.15
        assertEq(Units.roundPx(217_153, 3, true), 217_160); // → 217.16
        assertEq(Units.roundPx(217_150, 3, true), 217_150, "already on grid");
        assertEq(Units.roundPx(99_999, 3, true), 99_999, "5 digits untouched");
        assertEq(Units.roundPx(1_234_567, 3, false), 1_234_500); // 1234.567 → 1234.5
    }

    function test_roundPx_integerPricesAlwaysValid() public pure {
        // 123456.789 at szDecimals 3: 5 sig figs would be 123460, but integer prices are allowed
        assertEq(Units.roundPx(123_456_789, 3, false), 123_456_000);
        assertEq(Units.roundPx(123_456_789, 3, true), 123_457_000);
    }

    function test_roundPx_rejectsBadSzDecimals() public {
        vm.expectRevert(Units.BadSzDecimals.selector);
        h.roundPx(100, 7, false);
    }

    function test_offsetPx_floorAndCap() public pure {
        assertEq(Units.offsetPx(195_430, 100, false, 3), 193_470); // 193.4757 → 193.47
        assertEq(Units.offsetPx(195_430, 100, true, 3), 197_390); // 197.3843 → 197.39
    }

    /// @dev Every price the vault can send must survive Hyperliquid's tick check (see MockHyperCore).
    function testFuzz_offsetPx_isOnTheGrid(uint64 px, uint16 bps, bool up, uint8 szDec) public pure {
        szDec = uint8(bound(szDec, 0, 5));
        px = uint64(bound(px, 1e3, 1e12));
        bps = uint16(bound(bps, 0, 500));
        uint64 rounded = Units.offsetPx(px, bps, up, szDec);
        uint256 raw = rounded;
        if (raw % 10 ** (6 - szDec) != 0) {
            while (raw % 10 == 0) raw /= 10;
            uint256 digits;
            for (uint256 v = raw; v != 0; v /= 10) {
                ++digits;
            }
            assertLe(digits, 5, "at most 5 significant figures");
        }
        uint256 exact = up ? uint256(px) * (10_000 + bps) / 10_000 : uint256(px) * (10_000 - bps) / 10_000;
        if (up) assertGe(rounded, exact, "cap never tighter than asked");
        else assertLe(rounded, exact, "floor never tighter than asked");
    }

    // ─── money ────────────────────────────────────────────────────────────

    function test_value() public pure {
        assertEq(Units.value(40e18, 195.43e6), 7817.2e6);
    }

    function test_spotWei() public pure {
        assertEq(Units.usdcToSpotWei(1000e6), 1000e8);
        assertEq(Units.spotWeiToUsdc(4e8 + 99), 4e6);
    }

    function test_diffBps() public pure {
        assertEq(Units.diffBps(101, 100), 100);
        assertEq(Units.diffBps(99, 100), 100);
        assertEq(Units.diffBps(1, 0), type(uint256).max);
    }
}
