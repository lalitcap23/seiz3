// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {AfterbellBase} from "../utils/AfterbellBase.sol";
import {NaiveLiquidator} from "../../src/mocks/NaiveLiquidator.sol";

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
