// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {RemoteFlowTest} from "../remote/RemoteFlow.t.sol";

/// @notice The whole Base Sepolia round (RemoteFlowTest, every case) against the Morpho Blue and Uniswap v4 PoolManager
///         that Morpho and Uniswap deployed on Base Sepolia, on a fork: our market on their Morpho (no IRM, 77% LLTV,
///         both enabled there), our hooked pool on their PoolManager. HyperCore is still MockHyperCore behind the test
///         relayer. Skips without BASE_SEPOLIA_RPC_URL.
/// Run: BASE_SEPOLIA_RPC_URL=https://sepolia.base.org pnpm contracts:test:fork
contract BaseSepoliaForkTest is RemoteFlowTest {
    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;

    function setUp() public override {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 at = vm.envOr("BASE_SEPOLIA_FORK_BLOCK", uint256(0)); // pin one to reuse forge's RPC cache
        if (at == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, at);
        assertEq(block.chainid, 84_532, "not Base Sepolia");
        super.setUp();
    }

    function _chain() internal override {} // the fork's own block and time

    function _morpho() internal view override returns (IMorpho m) {
        m = IMorpho(MORPHO);
        require(MORPHO.code.length > 0, "no Morpho on this fork");
        require(m.isIrmEnabled(address(0)) && m.isLltvEnabled(LLTV), "Base Sepolia Morpho: IRM 0 / 77% not enabled");
    }

    function _poolManager() internal view override returns (IPoolManager) {
        require(POOL_MANAGER.code.length > 0, "no PoolManager on this fork");
        return IPoolManager(POOL_MANAGER);
    }
}
