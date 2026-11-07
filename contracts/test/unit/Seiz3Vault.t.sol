// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {Seiz3Base, MockUSDC} from "../utils/Seiz3Base.sol";
import {Seiz3Vault} from "../../src/Seiz3Vault.sol";
import {ISeiz3Vault} from "../../src/interfaces/ISeiz3Vault.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {HedgeLib} from "../../src/libs/HedgeLib.sol";
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";

/// @notice Ring 1: LP accounting, guards and admin. Morpho / v4 are real, HyperCore is MockHyperCore.
contract Seiz3VaultTest is Seiz3Base {
    // ─── LP accounting ────────────────────────────────────────────────────

    function test_totalAssets_countsEveryBox() public view {
        // idle + xyz account value + Core spot leftover; the only loss so far is the 1 USDC activation fee
        assertEq(usdc.balanceOf(address(vault)), LP_DEPOSIT - CORE_ACTIVATION - CORE_MARGIN);
        assertEq(vault.coreUsdc(), CORE_MARGIN + CORE_ACTIVATION - 1e6);
        assertEq(vault.totalAssets(), LP_DEPOSIT - 1e6);
    }

    function test_totalAssets_doesNotDipWhileUsdcIsInTransit() public {
        uint256 before = vault.totalAssets();
        vm.prank(owner);
        vault.topUpMargin(5000e6);
        assertEq(vault.totalAssets(), before, "same block: counted as in transit");
        _nextBlock(1);
        assertEq(vault.inTransit(), 0);
        assertEq(vault.totalAssets(), before, "next block: visible on Core");
    }

    function test_totalAssets_failsClosedWhenAReadFails() public {
        core.setFailReads(true);
        vm.expectRevert(
            abi.encodeWithSelector(HedgeLib.PrecompileFailed.selector, HLConstants.SPOT_BALANCE_PRECOMPILE_ADDRESS)
        );
        vault.totalAssets();
        usdc.mint(lp2, 1e6);
        vm.startPrank(lp2);
        usdc.approve(address(vault), 1e6);
        vm.expectRevert();
        vault.deposit(1e6, lp2);
        vm.stopPrank();
    }

    function test_deposit_blockedWhilePaused() public {
        vm.prank(owner);
        vault.pause();
        assertEq(vault.maxDeposit(lp2), 0);
        assertEq(vault.maxMint(lp2), 0);
        usdc.mint(lp2, 1e6);
        vm.startPrank(lp2);
        usdc.approve(address(vault), 1e6);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, lp2, 1e6, 0));
        vault.deposit(1e6, lp2);
        vm.stopPrank();
    }

    function test_firstDepositorInflation_isUnprofitable() public {
        vault = _newVault();
        address attacker = makeAddr("attacker");
        _deposit(attacker, 1); // 1 wei of USDC
        usdc.mint(address(vault), 10_000e6); // donation to inflate the share price
        uint256 victimShares = _deposit(lp2, 10_000e6);
        assertGt(victimShares, 0);
        assertApproxEqRel(vault.previewRedeem(victimShares), 10_000e6, 0.0001e18, "victim keeps their deposit");
    }

    // ─── withdrawals and the queue ────────────────────────────────────────

    function test_requestWithdraw_paysAtOnceFromIdle() public {
        uint256 shares = vault.convertToShares(10_000e6);
        vm.prank(lp);
        vault.requestWithdraw(shares);
        assertApproxEqAbs(usdc.balanceOf(lp), 10_000e6, 1);
        assertEq(vault.queuedShares(), 0);
    }

    function test_requestWithdraw_queuesWhenIdleIsShort() public {
        uint256 shares = vault.balanceOf(lp); // ~$100k, only ~$80k idle
        assertLt(vault.maxRedeem(lp), shares);
        vm.prank(lp);
        vault.requestWithdraw(shares);
        assertEq(vault.queued(lp), shares);
        assertEq(vault.queuedShares(), shares);
        assertEq(vault.balanceOf(address(vault)), shares);
        assertEq(vault.totalSupply(), shares, "queued shares keep sharing gains and losses");
        assertEq(usdc.balanceOf(lp), 0);
    }

    function test_requestWithdraw_rejectsZeroAndOverBalance() public {
        vm.startPrank(lp);
        vm.expectRevert(ISeiz3Vault.ZeroAmount.selector);
        vault.requestWithdraw(0);
        uint256 tooMany = vault.balanceOf(lp) + 1;
        vm.expectRevert(ISeiz3Vault.ExceedsBalance.selector);
        vault.requestWithdraw(tooMany);
        vm.stopPrank();
    }

    function test_claimQueued_paysWhatIsFreeThenTheRest() public {
        uint256 shares = vault.balanceOf(lp);
        vm.prank(lp);
        vault.requestWithdraw(shares);

        vm.prank(lp);
        vault.claimQueued(); // pays the idle part now
        uint256 first = usdc.balanceOf(lp);
        assertApproxEqAbs(first, LP_DEPOSIT - CORE_ACTIVATION - CORE_MARGIN, 1);
        assertGt(vault.queued(lp), 0, "rest stays queued");

        // flat vault: bring Core cash home, then the rest
        vault.sweepSpotToDex();
        _nextBlock(1);
        vault.withdrawMargin(core.accountValue(address(vault)));
        _nextBlock(1);
        vm.prank(lp);
        vault.claimQueued();
        assertApproxEqAbs(usdc.balanceOf(lp), LP_DEPOSIT - 1e6, 2, "everything but the activation fee");
        assertEq(vault.queued(lp), 0);

        vm.prank(lp);
        vm.expectRevert(ISeiz3Vault.NothingToClaim.selector);
        vault.claimQueued();
    }

    function test_queuedLPsArePaidBeforeNewInstantWithdrawals() public {
        uint256 shares = vault.balanceOf(lp);
        vm.prank(lp);
        vault.requestWithdraw(shares); // owed ~$100k, idle ~$80k
        _deposit(lp2, 5000e6);
        assertEq(vault.instantLiquidity(), 0, "every idle dollar is owed to the queue");
        assertEq(vault.maxWithdraw(lp2), 0);
    }

    function test_marginReserve_onlyHeldBackWithExposure() public {
        uint256 idle = usdc.balanceOf(address(vault));
        assertEq(vault.instantLiquidity(), idle, "flat: no reserve");
        _takeAndHedge();
        assertEq(
            vault.instantLiquidity(), usdc.balanceOf(address(vault)) - _risk().withdrawReserve, "exposed: reserve kept"
        );
    }

    // ─── callback guards ──────────────────────────────────────────────────

    function test_callback_rejectsNonMorpho() public {
        vm.expectRevert(ISeiz3Vault.NotMorpho.selector);
        vault.onMorphoLiquidate(1, abi.encode(bytes32(0), uint256(0)));
    }

    function test_callback_rejectsOutsideLiquidation() public {
        vm.prank(address(morpho));
        vm.expectRevert(ISeiz3Vault.NotInLiquidation.selector);
        vault.onMorphoLiquidate(1, abi.encode(bytes32(0), uint256(0)));
    }

    function test_unlockCallback_rejectsNonPoolManager() public {
        vm.expectRevert(ISeiz3Vault.NotPoolManager.selector);
        vault.unlockCallback(abi.encode(uint256(1), uint256(0)));
    }

    function test_unlockCallback_rejectsOutsideUnwind() public {
        vm.prank(address(pm));
        vm.expectRevert(ISeiz3Vault.NotInUnwind.selector);
        vault.unlockCallback(abi.encode(uint256(1), uint160(0)));
    }

    // ─── admin ────────────────────────────────────────────────────────────

    function test_admin_isOwnerOnly() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper);
        vm.startPrank(keeper);
        vm.expectRevert(err);
        vault.setRisk(risk);
        vm.expectRevert(err);
        vault.setMarketAllowed(market, false);
        vm.expectRevert(err);
        vault.setMarginDepositDex(DEX);
        vm.expectRevert(err);
        vault.activateCore(1e6);
        vm.expectRevert(err);
        vault.addApiWallet(keeper, "agent");
        vm.expectRevert(err);
        vault.pause();
        vm.expectRevert(err);
        vault.unpause();
        vm.expectRevert(err);
        vault.rescue(IERC20(address(nvdax)), keeper, 1);
        vm.stopPrank();
    }

    function test_setMarketAllowed_rejectsOtherTokens() public {
        MarketParams memory mp = market;
        mp.collateralToken = address(usdc);
        vm.prank(owner);
        vm.expectRevert(ISeiz3Vault.BadMarket.selector);
        vault.setMarketAllowed(mp, true);
    }

    function test_setMarginDepositDex_onlyXyzOrSpot() public {
        vm.startPrank(owner);
        vm.expectRevert(ISeiz3Vault.BadDex.selector);
        vault.setMarginDepositDex(0);
        vault.setMarginDepositDex(type(uint32).max);
        assertEq(vault.marginDepositDex(), type(uint32).max);
        vm.stopPrank();
    }

    function test_unpause_clearsEveryFlag() public {
        _takeAndHedge();
        core.forceDexBalance(address(vault), 0);
        vault.syncHedge();
        vm.prank(owner);
        vault.pause();
        assertEq(vault.pauseFlags(), vault.PAUSE_MARGIN() | vault.PAUSE_OWNER());
        vm.prank(owner);
        vault.unpause();
        assertEq(vault.pauseFlags(), 0);
        vault.syncHedge();
        assertEq(vault.pauseFlags(), vault.PAUSE_MARGIN(), "a sync re-pauses while margin is still short");
    }

    function test_ownerPause_doesNotStopSync() public {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);
        vm.prank(owner);
        vault.pause();
        _nextBlock(5);
        vault.syncHedge();
        assertEq(vault.confirmedShort(), -40_000);
    }

    function test_rescue_protectsLpFundsAndInventory() public {
        _takeAndHedge();
        vm.startPrank(owner);
        vm.expectRevert(ISeiz3Vault.NotRescuable.selector);
        vault.rescue(IERC20(address(usdc)), owner, 1);
        vm.expectRevert(ISeiz3Vault.NotRescuable.selector);
        vault.rescue(IERC20(address(vault)), owner, 1);
        vm.expectRevert(ISeiz3Vault.NotRescuable.selector);
        vault.rescue(IERC20(address(nvdax)), owner, 1);
        vm.stopPrank();

        _mintNvdax(address(vault), 3e18); // stray tokens on top of inventory
        ERC20Mock stray = new ERC20Mock();
        stray.mint(address(vault), 7);
        vm.startPrank(owner);
        vault.rescue(IERC20(address(nvdax)), owner, 3e18);
        vault.rescue(IERC20(address(stray)), owner, 7);
        vm.stopPrank();
        assertEq(nvdax.balanceOf(address(vault)), vault.inventory());
    }

    function test_addApiWallet_sendsAction9() public {
        vm.prank(owner);
        vault.addApiWallet(keeper, "seiz3-agent");
        _nextBlock(1);
        assertEq(core.apiWalletCount(), 1);
        assertEq(core.apiWallets(0), keeper);
    }

    function test_topUp_andActivate_guards() public {
        vm.startPrank(owner);
        vm.expectRevert(ISeiz3Vault.ZeroAmount.selector);
        vault.topUpMargin(0);
        vm.expectRevert(ISeiz3Vault.ExceedsIdle.selector);
        vault.topUpMargin(LP_DEPOSIT);
        vm.expectRevert(ISeiz3Vault.ZeroAmount.selector);
        vault.activateCore(0);
        vm.expectRevert(ISeiz3Vault.ExceedsIdle.selector);
        vault.activateCore(LP_DEPOSIT);
        vm.stopPrank();

        vault = _newVault();
        _deposit(lp2, 1000e6);
        vm.prank(owner);
        vm.expectRevert(ISeiz3Vault.CoreAccountMissing.selector);
        vault.topUpMargin(100e6);
    }

    function test_coreUsdc_isZeroBeforeTheVaultTouchesCore() public {
        vault = _newVault();
        core.setFailReads(true); // a plain EVM (forge script) has no precompiles at all
        _deposit(lp2, 1000e6);
        assertEq(vault.totalAssets(), 1000e6);
    }

    // ─── wiring ───────────────────────────────────────────────────────────

    function test_constructor_rejectsBadWiring() public {
        Seiz3Vault.Wiring memory w = _wiring();
        w.szDecimals = 7;
        _expectBadWiring(w);

        w = _wiring();
        w.perpAsset = 120_002; // dex 2 ≠ perpDexIndex 1
        _expectBadWiring(w);

        w = _wiring();
        w.poolKey.currency1 = Currency.wrap(address(0xdead));
        _expectBadWiring(w);

        w = _wiring();
        w.usdc = IERC20(address(new ERC20Mock())); // 18 decimals
        _expectBadWiring(w);
    }

    function test_constructor_derivesPerpIndex() public view {
        assertEq(vault.perpAsset(), PERP_ASSET);
        assertEq(vault.perpIndex(), PERP_INDEX);
        assertEq(vault.marginDepositDex(), DEX);
    }

    function _wiring() internal view returns (Seiz3Vault.Wiring memory) {
        return Seiz3Vault.Wiring({
            usdc: IERC20(address(usdc)),
            nvdax: IERC20(address(nvdax)),
            morpho: morpho,
            poolManager: pm,
            poolKey: DeployHelpers.poolKey(address(usdc), address(nvdax), address(hook)),
            risk: risk,
            coreDepositWallet: address(depositWallet),
            perpAsset: PERP_ASSET,
            perpDexIndex: DEX,
            szDecimals: SZ_DEC
        });
    }

    function _expectBadWiring(Seiz3Vault.Wiring memory w) internal {
        vm.expectRevert(ISeiz3Vault.BadWiring.selector);
        new Seiz3Vault(owner, w);
    }
}
