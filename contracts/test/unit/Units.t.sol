// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Units} from "../../src/libs/Units.sol";

contract UnitsTest is Test {
    function test_toCoreSize_roundsDown() public pure {
        // 1.234567 NVDAx with szDecimals = 3 → 1234
        assertEq(Units.toCoreSize(1.234567e18, 3), int64(1234));
    }

    function test_coreSize_roundTrip() public pure {
        assertEq(Units.fromCoreSize(-1234, 3), 1.234e18);
    }

    function test_sizeToWire() public pure {
        // 1.234 (sz 1234 @ 3 dec) → 1.234e8
        assertEq(Units.sizeToWire(1234, 3), 123_400_000);
    }

    function test_pxToWire() public pure {
        // szDecimals 3 → raw px has 3 decimals; 180.500 = 180500 → 180.5e8
        assertEq(Units.pxToWire(180_500, 3), 18_050_000_000);
    }

    function test_pxToUsdc() public pure {
        assertEq(Units.pxToUsdc(180_500, 3), 180.5e6);
    }

    function test_morphoPxToUsdc() public pure {
        // $180.5 → 180.5e6 × 1e18 (= 1e36 × 6dec / 18dec)
        assertEq(Units.morphoPxToUsdc(180.5e6 * 1e18), 180.5e6);
    }

    function testFuzz_coreSize_roundTrip(uint64 sz, uint8 szDec) public pure {
        szDec = uint8(bound(szDec, 0, 6));
        sz = uint64(bound(sz, 0, uint64(type(int64).max) / 10 ** 12));
        uint256 amt = Units.fromCoreSize(int64(sz), szDec);
        assertEq(Units.toCoreSize(amt, szDec), int64(sz));
    }
}
