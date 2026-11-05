// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UnwindLib} from "../../src/libs/UnwindLib.sol";
import {Units} from "../../src/libs/Units.sol";

contract UnwindLibTest is Test {
    function testFuzz_sqrtPrice_roundTrip(uint256 usd6, bool nvdax0) public pure {
        usd6 = bound(usd6, 1e6, 100_000e6);
        uint160 sqrtP = UnwindLib.sqrtPriceAt(usd6, nvdax0);
        assertApproxEqRel(UnwindLib.usdcPerNvdaxAt(sqrtP, nvdax0), usd6, 1e12); // 1e-6 relative
    }

    function test_sqrtPrice_orientation() public pure {
        // NVDAx as currency0: P = USDC units per NVDAx unit, tiny; as currency1 it is the inverse
        assertLt(UnwindLib.sqrtPriceAt(217e6, true), 1 << 96);
        assertGt(UnwindLib.sqrtPriceAt(217e6, false), 1 << 96);
    }

    function testFuzz_impactLimit_movesNvdaxPriceDownByBps(uint16 bps, bool nvdax0) public pure {
        bps = uint16(bound(bps, 1, 2000));
        uint256 px = 217.15e6;
        uint160 limit = UnwindLib.impactLimit(UnwindLib.sqrtPriceAt(px, nvdax0), bps, nvdax0);
        uint256 limitPx = UnwindLib.usdcPerNvdaxAt(limit, nvdax0);
        assertLt(limitPx, px, "selling NVDAx lowers its price");
        assertApproxEqAbs(Units.diffBps(limitPx, px), bps, 1);
    }

    function test_noLimit_isTheExtremeForTheDirection() public pure {
        assertLt(UnwindLib.noLimit(true), UnwindLib.sqrtPriceAt(1e6, true));
        assertGt(UnwindLib.noLimit(false), UnwindLib.sqrtPriceAt(1e6, false));
    }
}
