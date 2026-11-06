// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id, Position} from "@morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "@morpho-blue/libraries/MarketParamsLib.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {AfterbellVault} from "../../src/AfterbellVault.sol";
import {AfterbellHook, AFTERBELL_HOOK_FLAGS} from "../../src/AfterbellHook.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {UnwindLib} from "../../src/libs/UnwindLib.sol";
import {Units} from "../../src/libs/Units.sol";
import {MockNVDAx} from "../../src/mocks/MockNVDAx.sol";
import {DemoOracle} from "../../src/mocks/DemoOracle.sol";
import {PoolSeeder} from "../../src/mocks/PoolSeeder.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";
import {MockHyperCore, MockCoreDepositWallet} from "./MockHyperCore.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Real Morpho Blue + real Uniswap v4 PoolManager (deployed from their own artifacts) + AfterbellHook on the
///         vault's pool + MockHyperCore. After setUp the vault holds LP_DEPOSIT, its Core account is live with
///         CORE_MARGIN on xyz, market C is allow-listed and a borrower sits at 76% LTV ready to be pushed under water.
abstract contract AfterbellBase is Test {
    using MarketParamsLib for MarketParams;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint32 internal constant PERP_ASSET = 110_002; // xyz:NVDA: dex 1, index 2
    uint32 internal constant PERP_INDEX = 10_002;
    uint32 internal constant DEX = 1;
    uint8 internal constant SZ_DEC = 3;
    uint256 internal constant START_PX = 217.15e6; // USDC (6 dec) per NVDAx
    uint256 internal constant CRASH_PX = 195.43e6; // −10%
    uint256 internal constant LLTV = 0.77 ether;

    uint256 internal constant LP_DEPOSIT = 100_000e6;
    uint256 internal constant CORE_ACTIVATION = 5e6;
    uint256 internal constant CORE_MARGIN = 20_000e6;
    uint256 internal constant COLLATERAL = 100e18;
    uint256 internal constant SEIZE = 40e18; // 40 NVDA → 40_000 Core units
    uint256 internal constant POOL_DEPTH = 500_000e6; // USDC side of the "Monday" pool

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal lp2 = makeAddr("lp2");
    address internal keeper = makeAddr("keeper");
    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");

    MockUSDC internal usdc;
    MockNVDAx internal nvdax;
    IMorpho internal morpho;
    address internal irm;
    DemoOracle internal oracle;
    MarketParams internal market;

    IPoolManager internal pm;
    AfterbellHook internal hook;
    PoolKey internal key;
    bool internal nvdax0;
    PoolSeeder internal seeder;
    PoolSwapTest internal swapRouter;

    MockHyperCore internal core;
    MockCoreDepositWallet internal depositWallet;
    RiskParams internal risk;
    AfterbellVault internal vault;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        vm.roll(1000);

        usdc = new MockUSDC();
        nvdax = new MockNVDAx(owner);
        _deployMorpho();
        _deployPool();

        core = new MockHyperCore(usdc, PERP_INDEX, DEX, SZ_DEC);
        depositWallet = core.install(vm);
        core.setPx(_raw(START_PX));

        risk = new RiskParams(owner, DeployHelpers.defaultRisk());
        vault = _newVault();
        vm.startPrank(owner);
        hook.setVault(vault); // the hook's pool can only be initialised once it knows its vault
        vault.setMarketAllowed(market, true);
        vm.stopPrank();
        _seedPool();

        _bootstrap();
        _openBorrower(borrower, COLLATERAL, 7600);
    }

    // ─── deployment ───────────────────────────────────────────────────────

    function _deployMorpho() internal {
        morpho = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(owner)));
        irm = deployCode("IrmMock.sol:IrmMock");
        oracle = new DemoOracle(owner, START_PX * 1e18);
        market = MarketParams(address(usdc), address(nvdax), address(oracle), irm, LLTV);
        vm.startPrank(owner);
        morpho.enableIrm(irm);
        morpho.enableLltv(LLTV);
        morpho.createMarket(market);
        vm.stopPrank();

        usdc.mint(lender, 1_000_000e6);
        vm.startPrank(lender);
        usdc.approve(address(morpho), type(uint256).max);
        morpho.supply(market, 1_000_000e6, 0, lender, "");
        vm.stopPrank();
    }

    /// @dev PoolManager, the hook (at an address carrying its permission bits) and the hooked key. The pool is
    ///      initialised in `_seedPool`, after the hook is bound to the vault.
    function _deployPool() internal {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(owner)));
        hook = _deployHook(pm, owner);
        key = DeployHelpers.poolKey(address(usdc), address(nvdax), address(hook));
        nvdax0 = Currency.unwrap(key.currency0) == address(nvdax);
        seeder = new PoolSeeder(address(this), pm);
        swapRouter = new PoolSwapTest(pm);
    }

    function _seedPool() internal {
        seeder.initialize(key, UnwindLib.sqrtPriceAt(START_PX, nvdax0));
        _addLiquidity(_poolDepth(), 1000, bytes32(0));
    }

    /// @dev v4 reads a hook's permissions from its address. A fresh address per PoolManager keeps a re-run
    ///      `setUp` from landing on the previous hook's storage.
    function _deployHook(IPoolManager pm_, address owner_) internal returns (AfterbellHook) {
        address at = address(
            uint160(uint256(keccak256(abi.encode(address(pm_), "afterbell-hook")))) & ~Hooks.ALL_HOOK_MASK
                | AFTERBELL_HOOK_FLAGS
        );
        deployCodeTo("AfterbellHook.sol:AfterbellHook", abi.encode(pm_, owner_), at);
        return AfterbellHook(at);
    }

    /// @dev USDC side of the pool seeded in setUp. Override for weekend (thin) conditions.
    function _poolDepth() internal view virtual returns (uint256) {
        return POOL_DEPTH;
    }

    function _newVault() internal returns (AfterbellVault) {
        return new AfterbellVault(
            owner,
            AfterbellVault.Wiring({
                usdc: IERC20(address(usdc)),
                nvdax: IERC20(address(nvdax)),
                morpho: morpho,
                poolManager: pm,
                poolKey: key,
                risk: risk,
                coreDepositWallet: address(depositWallet),
                perpAsset: PERP_ASSET,
                perpDexIndex: DEX,
                szDecimals: SZ_DEC
            })
        );
    }

    /// @dev LP deposit → activate the Core account → wait a block → fund xyz margin → wait a block.
    function _bootstrap() internal {
        _deposit(lp, LP_DEPOSIT);
        vm.prank(owner);
        vault.activateCore(CORE_ACTIVATION);
        _nextBlock(1);
        vm.prank(owner);
        vault.topUpMargin(CORE_MARGIN);
        _nextBlock(1);
    }

    // ─── actors ───────────────────────────────────────────────────────────

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _mintNvdax(address to, uint256 amount) internal {
        vm.prank(owner);
        nvdax.mint(to, amount);
    }

    function _openBorrower(address who, uint256 collateral, uint256 ltvBps) internal {
        _mintNvdax(who, collateral);
        uint256 debt = Units.value(collateral, START_PX) * ltvBps / 10_000;
        vm.startPrank(who);
        nvdax.approve(address(morpho), collateral);
        morpho.supplyCollateral(market, collateral, who, "");
        morpho.borrow(market, debt, 0, who, who);
        vm.stopPrank();
    }

    function _liquidate(uint256 seized) internal {
        vm.prank(keeper);
        vault.liquidate(market, borrower, seized);
    }

    /// @dev Crash + liquidate + let the IOC land + sync: the vault ends Idle holding SEIZE, short 40_000.
    function _takeAndHedge() internal {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);
        _nextBlock(5);
        vm.prank(keeper);
        vault.syncHedge();
    }

    // ─── chain / market control ───────────────────────────────────────────

    /// @dev End the block: HyperCore runs the queued deposits and actions; the next reads see the result.
    function _nextBlock(uint256 secs) internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + secs);
        core.processBlock();
    }

    /// @dev Move both the lending oracle and the Core oracle/mark.
    function _setPrice(uint256 usd6) internal {
        vm.prank(owner);
        oracle.setPrice(usd6 * 1e18);
        core.setPx(_raw(usd6));
    }

    /// @dev Arbitrage the pool to `usd6` per NVDAx.
    function _alignPool(uint256 usd6) internal {
        uint160 target = UnwindLib.sqrtPriceAt(usd6, nvdax0);
        (uint160 current,,,) = pm.getSlot0(key.toId());
        if (target == current) return;
        bool zeroForOne = target < current;
        usdc.mint(address(this), 10_000_000e6);
        _mintNvdax(address(this), 100_000e18);
        usdc.approve(address(swapRouter), type(uint256).max);
        nvdax.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: -1e30, sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Add `usdcAmount` USDC (and the matching NVDAx) over ±rangeBps around the current pool price.
    function _addLiquidity(uint256 usdcAmount, uint256 rangeBps, bytes32 salt) internal {
        (uint160 sqrtP,,,) = pm.getSlot0(key.toId());
        uint256 nvdaxAmount = usdcAmount * 1e18 / UnwindLib.usdcPerNvdaxAt(sqrtP, nvdax0);
        (int24 lo, int24 hi) = _ticksAround(UnwindLib.usdcPerNvdaxAt(sqrtP, nvdax0), rangeBps);
        (uint256 a0, uint256 a1) = nvdax0 ? (nvdaxAmount, usdcAmount) : (usdcAmount, nvdaxAmount);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), a0, a1
        );
        usdc.mint(address(this), usdcAmount);
        _mintNvdax(address(this), nvdaxAmount);
        usdc.approve(address(seeder), type(uint256).max);
        nvdax.approve(address(seeder), type(uint256).max);
        seeder.modifyLiquidity(key, lo, hi, int256(uint256(liquidity)), salt);
    }

    function _ticksAround(uint256 price, uint256 rangeBps) internal view returns (int24 lo, int24 hi) {
        int24 a = TickMath.getTickAtSqrtPrice(UnwindLib.sqrtPriceAt(price * (10_000 - rangeBps) / 10_000, nvdax0));
        int24 b = TickMath.getTickAtSqrtPrice(UnwindLib.sqrtPriceAt(price * (10_000 + rangeBps) / 10_000, nvdax0));
        (lo, hi) = a < b ? (a, b) : (b, a);
        lo = (lo / 60 - (lo < 0 ? int24(1) : int24(0))) * 60;
        hi = (hi / 60 + 1) * 60;
    }

    function _setRisk(RiskParams.Params memory p) internal {
        vm.prank(owner);
        risk.setParams(p);
    }

    function _risk() internal view returns (RiskParams.Params memory) {
        return risk.get();
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    /// @dev USDC per NVDAx (6 dec) → raw perp px (3 decimals at szDecimals 3).
    function _raw(uint256 usd6) internal pure returns (uint64) {
        return uint64(usd6 / 10 ** SZ_DEC);
    }

    function _pending() internal view returns (int64 delta, uint8 tries) {
        (delta,,, tries) = vault.pendingHedge();
    }

    function _borrowShares(address who) internal view returns (uint256) {
        return morpho.position(market.id(), who).borrowShares;
    }

    function _coreUnits(uint256 nvdaxAmount) internal pure returns (int64) {
        return int64(Units.toCoreSize(nvdaxAmount, SZ_DEC));
    }
}
