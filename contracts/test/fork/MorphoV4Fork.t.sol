// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";
import {Units} from "../../src/libs/Units.sol";
import {SimBase} from "../utils/SimBase.sol";

/// @notice Ring 3: the Morpho Blue and Uniswap v4 PoolManager actually deployed on HyperEVM, with HyperCore
///         still simulated (forge has no HyperCore precompiles). Skips until spikes 5 & 6 provide addresses.
/// Run: MORPHO_ADDRESS=… MORPHO_IRM_ADDRESS=… POOL_MANAGER_ADDRESS=… pnpm contracts:test:fork
contract MorphoV4ForkTest is SimBase {
    address internal morphoAddr;
    address internal irmAddr;
    address internal pmAddr;

    function setUp() public override {
        morphoAddr = vm.envOr("MORPHO_ADDRESS", address(0));
        irmAddr = vm.envOr("MORPHO_IRM_ADDRESS", address(0));
        pmAddr = vm.envOr("POOL_MANAGER_ADDRESS", address(0));
        if (morphoAddr == address(0) || irmAddr == address(0) || pmAddr == address(0)) {
            vm.skip(true); // TODO: spikes 5 & 6
            return;
        }
        super.setUp();
    }

    function _morpho() internal override returns (IMorpho m, address irm) {
        m = IMorpho(morphoAddr);
        irm = irmAddr;
        require(morphoAddr.code.length > 0, "no Morpho at MORPHO_ADDRESS");
        bool irmOk = m.isIrmEnabled(irm);
        bool lltvOk = m.isLltvEnabled(LLTV);
        if (!irmOk || !lltvOk) {
            // spike finding: this market can't be created on mainnet as configured; enable on the fork only
            emit log("WARNING: IRM or 77% LLTV not enabled on this Morpho deployment (enabled on the fork only)");
            vm.startPrank(m.owner());
            if (!irmOk) m.enableIrm(irm);
            if (!lltvOk) m.enableLltv(LLTV);
            vm.stopPrank();
        }
    }

    function _poolManager() internal view override returns (IPoolManager) {
        require(pmAddr.code.length > 0, "no PoolManager at POOL_MANAGER_ADDRESS");
        return IPoolManager(pmAddr);
    }

    function test_morphoLiquidate_withCallback() public {
        _activateAndFund();
        uint256 debtBefore = morpho.position(_marketId(), borrower).borrowShares;
        _crashAndLiquidate();
        assertLt(morpho.position(_marketId(), borrower).borrowShares, debtBefore, "real Morpho repaid in the callback");
        assertEq(vault.inventory(), SEIZE);
        _syncLater();
        assertEq(PrecompileLib.position(address(vault), PERP_INDEX).szi, -int64(Units.toCoreSize(SEIZE, szDec)));
    }

    function test_v4Swap_throughUnlock() public {
        _activateAndFund();
        _crashAndLiquidate();
        _syncLater();
        vm.prank(owner);
        risk.setMarketOpen(true);
        uint256 idle = usdc.balanceOf(address(vault));
        vault.unwindStep();
        assertGt(usdc.balanceOf(address(vault)), idle, "real PoolManager paid out through unlock");
        assertLt(vault.inventory(), SEIZE);
    }
}
