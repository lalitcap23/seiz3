// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {AfterbellBase} from "../utils/AfterbellBase.sol";
import {NaiveLiquidator} from "../../src/mocks/NaiveLiquidator.sol";
import {UnwindLib} from "../../src/libs/UnwindLib.sol";

/// @notice Demo Market A vs Market C on a thin weekend pool: same crash, same seizure, different outcome.
contract NaiveLiquidatorTest is AfterbellBase {
    NaiveLiquidator internal naive;
    address internal borrower2 = makeAddr("borrower2");

    function _poolDepth() internal pure override returns (uint256) {
        return 2000e6; // weekend: a couple of thousand dollars of depth
    }

    function setUp() public override {
        super.setUp();
        naive = new NaiveLiquidator(owner, morpho, pm, key, nvdax);
        usdc.mint(address(naive), 50_000e6); // its own balance covers the shortfall
        _openBorrower(borrower2, COLLATERAL, 7600);
        _setPrice(CRASH_PX);
    }

    function test_naive_dumpsIntoThinPoolAndEatsAShortfall() public {
        uint256 before = usdc.balanceOf(address(naive));
        vm.prank(owner);
        uint256 repaid = naive.liquidate(market, borrower, SEIZE);

        uint256 shortfall = naive.totalShortfall();
        assertGt(shortfall, repaid / 2, "a $2k pool can't absorb ~$7.8k of stock");
        assertEq(before - usdc.balanceOf(address(naive)), shortfall, "topped up from its own balance");
        assertGt(nvdax.balanceOf(address(naive)), 0, "the pool ran out before the stock did");
    }

    function test_afterbell_takesTheSameSeizureWithoutAShortfall() public {
        uint256 before = vault.totalAssets();
        vm.prank(keeper);
        vault.liquidate(market, borrower2, SEIZE);
        assertGt(vault.totalAssets(), before, "bought at a discount, marked at the oracle, hedged");
        assertEq(vault.inventory(), SEIZE, "nothing dumped into the thin pool");
    }

    /// Monday: the arbitrage swap puts the dumped pool back on the oracle for next to nothing.
    function test_seeder_swapsTheDumpedPoolBackToTheOracle() public {
        vm.prank(owner);
        naive.liquidate(market, borrower, SEIZE);
        (, uint256 dumped) = UnwindLib.poolPrice(pm, key, nvdax0);
        assertLt(dumped, CRASH_PX / 2, "the dump emptied the thin pool's range");

        usdc.mint(address(this), 1000e6);
        uint256 below = CRASH_PX * 95 / 100; // under the old ±10% range: no liquidity on the way up
        seeder.swapToPrice(key, UnwindLib.sqrtPriceAt(below, nvdax0));
        assertGt(usdc.balanceOf(address(this)), 999e6, "crossing empty ticks costs under a dollar");

        seeder.swapToPrice(key, UnwindLib.sqrtPriceAt(CRASH_PX, nvdax0));
        (, uint256 restored) = UnwindLib.poolPrice(pm, key, nvdax0);
        assertApproxEqRel(restored, CRASH_PX, 1e14, "back on the oracle"); // 0.01%
    }

    function test_seeder_swapToPriceIsOwnerOnly() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        seeder.swapToPrice(key, UnwindLib.sqrtPriceAt(CRASH_PX, nvdax0));
    }

    function test_naive_isOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        naive.liquidate(market, borrower, SEIZE);
    }

    function test_naive_rejectsOtherMarkets() public {
        MarketParams memory mp = market;
        (mp.loanToken, mp.collateralToken) = (mp.collateralToken, mp.loanToken);
        vm.prank(owner);
        vm.expectRevert(NaiveLiquidator.WrongMarket.selector);
        naive.liquidate(mp, borrower, SEIZE);
    }
}
