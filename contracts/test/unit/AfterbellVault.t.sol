// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {AfterbellVault} from "../../src/AfterbellVault.sol";
import {IAfterbellVault} from "../../src/interfaces/IAfterbellVault.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {MockNVDAx} from "../../src/mocks/MockNVDAx.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";

/// @notice Ring 1: math and guards, Morpho / PoolManager / CoreWriter mocked or absent.
contract AfterbellVaultTest is Test {
    address owner = makeAddr("owner");
    address lp = makeAddr("lp");
    address morpho = makeAddr("morpho");
    address poolManager = makeAddr("poolManager");

    ERC20Mock usdc;
    MockNVDAx nvdax;
    RiskParams risk;
    AfterbellVault vault;

    function setUp() public {
        usdc = new ERC20Mock();
        nvdax = new MockNVDAx(owner);
        risk = new RiskParams(owner, DeployHelpers.defaultRisk());

        (Currency c0, Currency c1) = address(usdc) < address(nvdax)
            ? (Currency.wrap(address(usdc)), Currency.wrap(address(nvdax)))
            : (Currency.wrap(address(nvdax)), Currency.wrap(address(usdc)));

        vault = new AfterbellVault(
            owner,
            AfterbellVault.Wiring({
                usdc: IERC20(address(usdc)),
                nvdax: IERC20(address(nvdax)),
                morpho: IMorpho(morpho),
                poolManager: IPoolManager(poolManager),
                poolKey: PoolKey(c0, c1, 3000, 60, IHooks(address(0))),
                risk: risk,
                perpAsset: 110_000,
                perpDexIndex: 1,
                szDecimals: 3
            })
        );
    }

    function test_deposit_mintsShares() public {
        usdc.mint(lp, 1000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        uint256 shares = vault.deposit(1000e6, lp);
        vm.stopPrank();
        assertGt(shares, 0);
        assertEq(vault.totalAssets(), 1000e6);
    }

    function test_callback_rejectsNonMorpho() public {
        vm.expectRevert(IAfterbellVault.NotMorpho.selector);
        vault.onMorphoLiquidate(1, abi.encode(bytes32(0), uint256(0)));
    }

    function test_callback_rejectsOutsideLiquidation() public {
        vm.prank(morpho);
        vm.expectRevert(IAfterbellVault.NotInLiquidation.selector);
        vault.onMorphoLiquidate(1, abi.encode(bytes32(0), uint256(0)));
    }

    function test_unlockCallback_rejectsNonPoolManager() public {
        vm.expectRevert(IAfterbellVault.NotPoolManager.selector);
        vault.unlockCallback(abi.encode(uint256(1), uint256(0)));
    }

    function test_liquidate_revertsWhenPaused() public {
        vm.prank(owner);
        vault.pause();
        MarketParams memory mp;
        vm.expectRevert(IAfterbellVault.VaultPaused.selector);
        vault.liquidate(mp, address(1), 1);
    }
}
