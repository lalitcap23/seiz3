// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HedgeLib} from "../../src/libs/HedgeLib.sol";

contract HedgeLibTest is Test {
    function test_perpIndexOf() public pure {
        assertEq(HedgeLib.perpIndexOf(110_002), 10_002, "HIP-3: reads drop the 100000 offset");
        assertEq(HedgeLib.perpIndexOf(4), 4, "native perps use one id");
    }

    function test_makeCloid_isDeterministicPerAttempt() public pure {
        bytes32 id = keccak256("liq-1");
        assertEq(HedgeLib.makeCloid(id, 1), HedgeLib.makeCloid(id, 1));
        assertTrue(HedgeLib.makeCloid(id, 1) != HedgeLib.makeCloid(id, 2));
    }
}
