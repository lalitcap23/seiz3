// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";
import {HedgeLib} from "../../src/libs/HedgeLib.sol";

contract CoreWriterRecorder {
    bytes public last;

    function sendRawAction(bytes calldata data) external {
        last = data;
    }
}

contract GasBurner {
    fallback() external {
        while (true) {}
    }
}

contract OracleReturns {
    uint64 immutable px;

    constructor(uint64 px_) {
        px = px_;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(px);
    }
}

contract HedgeLibHarness {
    function limitOrderIoc(uint32 a, bool b, uint64 px, uint64 sz, bool ro, uint128 c) external {
        HedgeLib.limitOrderIoc(a, b, px, sz, ro, c);
    }

    function sendAsset(address d, uint32 s, uint32 t, uint64 tok, uint64 w) external {
        HedgeLib.sendAsset(d, s, t, tok, w);
    }

    function spotSend(address d, uint64 tok, uint64 w) external {
        HedgeLib.spotSend(d, tok, w);
    }

    function addApiWallet(address w, string calldata n) external {
        HedgeLib.addApiWallet(w, n);
    }

    function oraclePx(uint32 idx) external view returns (uint64) {
        return HedgeLib.oraclePx(idx);
    }
}

/// @notice CoreWriter payloads byte-for-byte (1 version byte + 3-byte big-endian action id + abi.encode(params))
///         and the read guards. A malformed payload is silently dropped on Core, so these are worth pinning.
contract HedgeLibTest is Test {
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    HedgeLibHarness h;

    function setUp() public {
        h = new HedgeLibHarness();
        vm.etch(CORE_WRITER, address(new CoreWriterRecorder()).code);
    }

    function _last() internal view returns (bytes memory) {
        return CoreWriterRecorder(CORE_WRITER).last();
    }

    function test_limitOrder_payload() public {
        h.limitOrderIoc(110_002, false, 19_347e6, 40_000e5, false, 42);
        bytes memory params =
            abi.encode(uint32(110_002), false, uint64(19_347e6), uint64(40_000e5), false, uint8(3), uint128(42));
        assertEq(_last(), abi.encodePacked(hex"01", hex"000001", params));
    }

    function test_sendAsset_payload() public {
        h.sendAsset(address(this), type(uint32).max, 1, 0, 1000e8);
        bytes memory params =
            abi.encode(address(this), address(0), type(uint32).max, uint32(1), uint64(0), uint64(1000e8));
        assertEq(_last(), abi.encodePacked(hex"01", hex"00000d", params));
    }

    function test_spotSend_payload() public {
        h.spotSend(HedgeLib.USDC_SYSTEM_ADDRESS, 0, 5e8);
        bytes memory params = abi.encode(HedgeLib.USDC_SYSTEM_ADDRESS, uint64(0), uint64(5e8));
        assertEq(_last(), abi.encodePacked(hex"01", hex"000006", params));
    }

    function test_addApiWallet_payload() public {
        h.addApiWallet(address(0xBEEF), "afterbell-agent");
        assertEq(_last(), abi.encodePacked(hex"01", hex"000009", abi.encode(address(0xBEEF), "afterbell-agent")));
    }

    function test_perpIndexOf() public pure {
        assertEq(HedgeLib.perpIndexOf(110_002), 10_002, "HIP-3: reads drop the 100000 offset");
        assertEq(HedgeLib.perpIndexOf(4), 4, "native perps use one id");
    }

    function test_makeCloid_isDeterministicPerAttempt() public pure {
        bytes32 id = keccak256("liq-1");
        assertEq(HedgeLib.makeCloid(id, 1), HedgeLib.makeCloid(id, 1));
        assertTrue(HedgeLib.makeCloid(id, 1) != HedgeLib.makeCloid(id, 2));
    }

    function test_read_capsGasOnABadPrecompile() public {
        vm.etch(HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS, address(new GasBurner()).code);
        uint256 before = gasleft();
        vm.expectRevert(
            abi.encodeWithSelector(HedgeLib.PrecompileFailed.selector, HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS)
        );
        h.oraclePx(10_002);
        assertLt(before - gasleft(), 150_000, "lost the capped 100k, not the whole tx");
    }

    function test_read_revertsCleanlyWithoutAPrecompile() public {
        // plain EVM (forge script, anvil): the address has no code and returns nothing
        vm.expectRevert(
            abi.encodeWithSelector(HedgeLib.PrecompileFailed.selector, HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS)
        );
        h.oraclePx(10_002);
    }

    function test_oraclePx_zeroMeansUnknownAsset() public {
        vm.etch(HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS, address(new OracleReturns(0)).code);
        vm.expectRevert(
            abi.encodeWithSelector(HedgeLib.PrecompileFailed.selector, HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS)
        );
        h.oraclePx(10_002);

        vm.etch(HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS, address(new OracleReturns(217_150)).code);
        assertEq(h.oraclePx(10_002), 217_150);
    }
}
