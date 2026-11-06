// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "@morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "@morpho-blue/libraries/MarketParamsLib.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";
import {HyperCore} from "@hyper-evm-lib/test/simulation/HyperCore.sol";
import {CoreSimulatorLib} from "@hyper-evm-lib/test/simulation/CoreSimulatorLib.sol";

import {AfterbellVault} from "../../src/AfterbellVault.sol";
import {AfterbellHook, AFTERBELL_HOOK_FLAGS} from "../../src/AfterbellHook.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {MockNVDAx} from "../../src/mocks/MockNVDAx.sol";
import {DemoOracle} from "../../src/mocks/DemoOracle.sol";
import {PoolSeeder} from "../../src/mocks/PoolSeeder.sol";
import {UnwindLib} from "../../src/libs/UnwindLib.sol";
import {Units} from "../../src/libs/Units.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";

/// @notice hyper-evm-lib's CoreSimulator on a HyperEVM mainnet fork, with real USDC, Circle's real
///         CoreDepositWallet and live xyz:NVDA metadata (asset 110002, perp index 10002). Ring 2 deploys
///         Morpho and the v4 PoolManager locally; ring 3 overrides `_morpho` / `_poolManager` with the
///         deployed ones.
/// @dev The simulator has no oracle setter, so "the crash" moves the Morpho oracle down onto the live Core
///      oracle; fills happen at a mark price we pin to that oracle.
abstract contract SimBase is Test {
    uint32 constant PERP_ASSET = 110_002;
    uint32 constant PERP_INDEX = 10_002;
    uint32 constant DEX = 1;
    uint256 constant LLTV = 0.77 ether;
    uint256 constant SEIZE = 40e18;

    address owner = makeAddr("owner");
    address lp = makeAddr("lp");
    address lender = makeAddr("lender");
    address borrower = makeAddr("borrower");
    address creForwarder = makeAddr("creForwarder");

    HyperCore hyperCore;
    IERC20 usdc;
    MockNVDAx nvdax;
    IMorpho morpho;
    DemoOracle oracle;
    MarketParams market;
    IPoolManager pm;
    AfterbellHook hook;
    PoolKey key;
    RiskParams risk;
    AfterbellVault vault;

    uint8 szDec;
    uint64 corePx; // live raw oracle px
    uint256 pxUsdc;

    function setUp() public virtual {
        vm.createSelectFork(vm.envOr("HYPEREVM_RPC_URL", string("https://rpc.hyperliquid.xyz/evm")));
        hyperCore = CoreSimulatorLib.init();
        usdc = IERC20(HLConstants.usdc());

        szDec = PrecompileLib.perpAssetInfo(PERP_INDEX).szDecimals;
        corePx = PrecompileLib.oraclePx(PERP_INDEX);
        pxUsdc = Units.pxToUsdc(corePx, szDec);
        CoreSimulatorLib.setMarkPx(PERP_INDEX, corePx);

        nvdax = new MockNVDAx(owner);
        _deployMorpho();
        _deployPool();

        risk = new RiskParams(owner, creForwarder, DeployHelpers.defaultRisk());
        vault = new AfterbellVault(
            owner,
            AfterbellVault.Wiring({
                usdc: usdc,
                nvdax: IERC20(address(nvdax)),
                morpho: morpho,
                poolManager: pm,
                poolKey: key,
                risk: risk,
                coreDepositWallet: HLConstants.coreDepositWallet(),
                perpAsset: PERP_ASSET,
                perpDexIndex: DEX,
                szDecimals: szDec
            })
        );
        vm.startPrank(owner);
        hook.setVault(vault);
        vault.setMarketAllowed(market, true);
        vm.stopPrank();
        _seedPool();

        deal(address(usdc), lp, 100_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, lp);
        vm.stopPrank();
    }

    /// @dev Ring 2: fresh Morpho Blue from its own artifact, owned by `owner`.
    function _morpho() internal virtual returns (IMorpho m, address irm) {
        m = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(owner)));
        irm = deployCode("IrmMock.sol:IrmMock");
        vm.startPrank(owner);
        m.enableIrm(irm);
        m.enableLltv(LLTV);
        vm.stopPrank();
    }

    /// @dev Ring 2: fresh PoolManager from its own artifact.
    function _poolManager() internal virtual returns (IPoolManager) {
        return IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(owner)));
    }

    function _deployMorpho() internal {
        address irm;
        (morpho, irm) = _morpho();
        // weekend price 12% above where Core trades now; the "crash" brings it down onto Core
        oracle = new DemoOracle(owner, pxUsdc * 112 / 100 * 1e18);
        market = MarketParams(address(usdc), address(nvdax), address(oracle), irm, LLTV);
        morpho.createMarket(market);

        deal(address(usdc), lender, 1_000_000e6);
        vm.startPrank(lender);
        usdc.approve(address(morpho), type(uint256).max);
        morpho.supply(market, 1_000_000e6, 0, lender, "");
        vm.stopPrank();

        vm.prank(owner);
        nvdax.mint(borrower, 100e18);
        vm.startPrank(borrower);
        nvdax.approve(address(morpho), type(uint256).max);
        morpho.supplyCollateral(market, 100e18, borrower, "");
        morpho.borrow(market, Units.value(100e18, pxUsdc * 112 / 100) * 76 / 100, 0, borrower, borrower);
        vm.stopPrank();
    }

    /// @dev The hook goes at an address carrying its permission bits; the pool is seeded once the hook knows its vault.
    function _deployPool() internal {
        pm = _poolManager();
        address at = address(
            uint160(uint256(keccak256(abi.encode(address(pm), "afterbell-hook")))) & ~Hooks.ALL_HOOK_MASK
                | AFTERBELL_HOOK_FLAGS
        );
        deployCodeTo("AfterbellHook.sol:AfterbellHook", abi.encode(pm, owner), at);
        hook = AfterbellHook(at);
        key = DeployHelpers.poolKey(address(usdc), address(nvdax), address(hook));
    }

    function _seedPool() internal {
        bool nvdax0 = Currency.unwrap(key.currency0) == address(nvdax);
        PoolSeeder seeder = new PoolSeeder(address(this), pm);
        uint160 sqrtP = UnwindLib.sqrtPriceAt(pxUsdc, nvdax0);
        seeder.initialize(key, sqrtP);

        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 lo = (tick / 60 - 100) * 60;
        int24 hi = (tick / 60 + 100) * 60;
        uint256 usdcAmt = 500_000e6;
        uint256 nvdaxAmt = usdcAmt * 1e18 / pxUsdc;
        (uint256 a0, uint256 a1) = nvdax0 ? (nvdaxAmt, usdcAmt) : (usdcAmt, nvdaxAmt);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), a0, a1
        );
        deal(address(usdc), address(this), usdcAmt);
        vm.prank(owner);
        nvdax.mint(address(this), nvdaxAmt);
        usdc.approve(address(seeder), type(uint256).max);
        nvdax.approve(address(seeder), type(uint256).max);
        seeder.modifyLiquidity(key, lo, hi, int256(uint256(liq)), bytes32(0));
    }

    /// @dev The real deploy flow: activate (spot deposit), then fund xyz margin through the two-hop route.
    function _activateAndFund() internal {
        vm.prank(owner);
        vault.activateCore(5e6);
        CoreSimulatorLib.nextBlock();
        assertTrue(PrecompileLib.coreUserExists(address(vault)), "account live after one block");

        vm.startPrank(owner);
        vault.setMarginDepositDex(type(uint32).max);
        vault.topUpMargin(20_000e6);
        vm.stopPrank();
        CoreSimulatorLib.nextBlock();
        // VERIFY on testnet: CoreWriter can't set leverage, the simulator needs one for the position
        CoreSimulatorLib.forcePerpLeverage(address(vault), PERP_INDEX, 3);
    }

    function _crashAndLiquidate() internal {
        vm.prank(owner);
        oracle.setPrice(pxUsdc * 1e18);
        vault.liquidate(market, borrower, SEIZE);
    }

    function _marketId() internal view returns (Id) {
        return MarketParamsLib.id(market);
    }

    function _syncLater() internal {
        CoreSimulatorLib.nextBlock();
        vm.warp(block.timestamp + 5);
        vault.syncHedge();
    }

    /// @dev Liquidate and hedge, then buyers bid the token 1% over the Core oracle on the curve and one more buys a
    ///      full chunk from the vault through the hook; the next sync must see the buy-back on Core.
    function _hookFillAndSync() internal {
        _activateAndFund();
        _crashAndLiquidate();
        _syncLater();
        vm.prank(owner);
        risk.setMarketOpen(true);

        PoolSwapTest router = new PoolSwapTest(pm);
        address buyer = makeAddr("buyer");
        deal(address(usdc), buyer, 100_000e6);
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
        bool nvdax0 = Currency.unwrap(key.currency0) == address(nvdax);
        bool buyDir = !nvdax0; // pay USDC in

        _swap(router, buyer, buyDir, -1e30, UnwindLib.sqrtPriceAt(pxUsdc * 101 / 100, nvdax0));
        uint256 chunk = Units.fromCoreSize(DeployHelpers.defaultRisk().maxUnhedged, szDec);
        _swap(router, buyer, buyDir, int256(chunk), buyDir ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        assertEq(vault.inventory(), SEIZE - chunk, "filled from inventory");

        _syncLater();
        int64 expected = -int64(Units.toCoreSize(SEIZE - chunk, szDec));
        assertEq(vault.confirmedShort(), expected, "the buy-back landed");
        assertEq(PrecompileLib.position(address(vault), PERP_INDEX).szi, expected);
        (int64 delta,,,) = vault.pendingHedge();
        assertEq(delta, 0);
    }

    function _swap(PoolSwapTest router, address who, bool zeroForOne, int256 amount, uint160 limit) internal {
        vm.prank(who);
        router.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: amount, sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
