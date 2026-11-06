// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
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
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";

import {AFTERBELL_HOOK_FLAGS} from "../../src/AfterbellHook.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {UnwindLib} from "../../src/libs/UnwindLib.sol";
import {Units} from "../../src/libs/Units.sol";
import {MockNVDAx} from "../../src/mocks/MockNVDAx.sol";
import {DemoOracle} from "../../src/mocks/DemoOracle.sol";
import {PoolSeeder} from "../../src/mocks/PoolSeeder.sol";
import {HyperCoreGateway} from "../../src/remote/HyperCoreGateway.sol";
import {AfterbellVaultRemote} from "../../src/remote/AfterbellVaultRemote.sol";
import {AfterbellHookRemote} from "../../src/remote/AfterbellHookRemote.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";
import {MockUSDC} from "../utils/AfterbellBase.sol";
import {MockHyperCore} from "../utils/MockHyperCore.sol";

/// @notice The Base Sepolia shape of the system: real Morpho Blue and Uniswap v4 bytecode on a chain with no HyperCore,
///         AfterbellVaultRemote + AfterbellHookRemote wired to a HyperCoreGateway, and HyperCore itself played by
///         MockHyperCore at an ordinary address that only the test's relayer talks to. Nothing is etched over the
///         precompiles or CoreWriter, so any read or write the vault or hook made there would fail these tests.
/// @dev `_relay()` is the relayer: place every unacknowledged gateway order on HyperCore from the hedge account,
///      let HyperCore process the block, then post a snapshot that acknowledges them.
abstract contract RemoteBase is Test {
    using MarketParamsLib for MarketParams;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint32 internal constant PERP_ASSET = 110_002; // xyz:NVDA: dex 1, index 2
    uint32 internal constant PERP_INDEX = 10_002;
    uint32 internal constant DEX = 1;
    uint8 internal constant SZ_DEC = 3;
    uint256 internal constant START_PX = 217.15e6;
    uint256 internal constant CRASH_PX = 195.43e6; // −10%
    uint256 internal constant LLTV = 0.77 ether;

    uint256 internal constant LP_DEPOSIT = 100_000e6;
    uint64 internal constant CORE_MARGIN = 20_000e6; // on HyperCore, funded there (no bridge from this chain)
    uint256 internal constant COLLATERAL = 100e18;
    uint256 internal constant SEIZE = 40e18; // 40 NVDA → 40_000 Core units
    uint256 internal constant POOL_DEPTH = 500_000e6;

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal keeper = makeAddr("keeper");
    address internal creForwarder = makeAddr("creForwarder");
    address internal relayer = makeAddr("relayer");
    address internal hedge = makeAddr("hedgeAccount"); // the HyperCore account that holds the short
    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");

    MockUSDC internal usdc;
    MockNVDAx internal nvdax;
    IMorpho internal morpho;
    DemoOracle internal oracle;
    MarketParams internal market;

    IPoolManager internal pm;
    AfterbellHookRemote internal hook;
    PoolKey internal key;
    bool internal nvdax0;
    PoolSeeder internal seeder;
    PoolSwapTest internal swapRouter;

    MockHyperCore internal core; // HyperCore, on the other side of the relayer
    HyperCoreGateway internal gateway;
    RiskParams internal risk;
    AfterbellVaultRemote internal vault;

    function setUp() public virtual {
        _chain();
        usdc = new MockUSDC();
        nvdax = new MockNVDAx(owner);
        _deployMorpho();
        pm = _poolManager();
        seeder = new PoolSeeder(address(this), pm);
        swapRouter = new PoolSwapTest(pm);

        core = new MockHyperCore(usdc, PERP_INDEX, DEX, SZ_DEC);
        core.setPx(_raw(START_PX));
        core.forceActivate(hedge);
        core.forceDexBalance(hedge, CORE_MARGIN);

        risk = new RiskParams(owner, creForwarder, DeployHelpers.defaultRisk());
        gateway = new HyperCoreGateway(owner, creForwarder, relayer, PERP_INDEX, DEX);
        hook = _deployHook(pm, owner);
        key = DeployHelpers.poolKey(address(usdc), address(nvdax), address(hook));
        nvdax0 = Currency.unwrap(key.currency0) == address(nvdax);
        vault = _newVault();

        vm.startPrank(owner);
        gateway.setAccount(address(vault));
        gateway.setHedgeAccount(hedge);
        hook.setVault(vault);
        vault.setMarketAllowed(market, true);
        vm.stopPrank();
        _seedPool();

        _bootstrap();
        _openBorrower(borrower, COLLATERAL, 7600);
    }

    // ─── deployment (virtual: the fork test swaps in Base Sepolia's own Morpho and PoolManager) ───

    function _chain() internal virtual {
        vm.warp(1_760_000_000);
        vm.roll(1000);
    }

    /// @dev Morpho as Base Sepolia has it: no IRM (address(0) is enabled there), 77% LLTV.
    function _morpho() internal virtual returns (IMorpho m) {
        m = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(owner)));
        vm.startPrank(owner);
        m.enableIrm(address(0));
        m.enableLltv(LLTV);
        vm.stopPrank();
    }

    function _poolManager() internal virtual returns (IPoolManager) {
        return IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(owner)));
    }

    function _deployMorpho() internal {
        morpho = _morpho();
        oracle = new DemoOracle(owner, START_PX * 1e18);
        market = MarketParams(address(usdc), address(nvdax), address(oracle), address(0), LLTV);
        morpho.createMarket(market); // anyone may create a market on an enabled IRM + LLTV

        usdc.mint(lender, 1_000_000e6);
        vm.startPrank(lender);
        usdc.approve(address(morpho), type(uint256).max);
        morpho.supply(market, 1_000_000e6, 0, lender, "");
        vm.stopPrank();
    }

    function _deployHook(IPoolManager pm_, address owner_) internal returns (AfterbellHookRemote) {
        address at = address(
            uint160(uint256(keccak256(abi.encode(address(pm_), "afterbell-hook-remote")))) & ~Hooks.ALL_HOOK_MASK
                | AFTERBELL_HOOK_FLAGS
        );
        deployCodeTo("AfterbellHookRemote.sol:AfterbellHookRemote", abi.encode(pm_, owner_), at);
        return AfterbellHookRemote(at);
    }

    function _newVault() internal returns (AfterbellVaultRemote) {
        return new AfterbellVaultRemote(
            owner,
            AfterbellVaultRemote.Wiring({
                usdc: IERC20(address(usdc)),
                nvdax: IERC20(address(nvdax)),
                morpho: morpho,
                poolManager: pm,
                poolKey: key,
                risk: risk,
                gateway: gateway,
                perpAsset: PERP_ASSET,
                perpDexIndex: DEX,
                szDecimals: SZ_DEC
            })
        );
    }

    function _seedPool() internal {
        seeder.initialize(key, UnwindLib.sqrtPriceAt(START_PX, nvdax0));
        _addLiquidity(POOL_DEPTH, 1000, bytes32(0));
    }

    /// @dev LP deposit (no gateway reads yet) → first relayer snapshot → the vault counts the hedge account.
    function _bootstrap() internal {
        _deposit(lp, LP_DEPOSIT);
        _post(0);
        vm.prank(owner);
        vault.activateCore(0);
    }

    // ─── the relayer ──────────────────────────────────────────────────────

    /// @dev Place every unacknowledged order on HyperCore from the hedge account (CoreWriter's limit-order action, as
    ///      the relayer sends it through Hyperliquid's API), end HyperCore's block, then acknowledge them.
    function _relay() internal {
        uint64 n = gateway.actionCount();
        for (uint64 i = gateway.executedNonce() + 1; i <= n; ++i) {
            HyperCoreGateway.Order memory o = gateway.orders(i);
            bytes memory action = abi.encodePacked(
                uint8(1),
                HLConstants.LIMIT_ORDER_ACTION,
                abi.encode(o.asset, o.isBuy, o.limitPx, o.sz, o.reduceOnly, o.tif, o.cloid)
            );
            vm.prank(core.CORE_WRITER());
            core.enqueue(hedge, action);
        }
        core.processBlock();
        _nextBlock(5); // a few seconds on the relayer's side; also the default orderDelaySec
        _post(n);
    }

    /// @dev The hedge account as HyperCore shows it a second later, acknowledging orders up to `executed`. (The gateway
    ///      keeps only strictly newer observations, and the real relayer never posts twice in one second.)
    function _post(uint64 executed) internal {
        _nextBlock(1);
        HyperCoreGateway.Snapshot memory s = _snapshot(executed);
        vm.prank(relayer);
        gateway.relay(s);
    }

    function _snapshot(uint64 executed) internal view returns (HyperCoreGateway.Snapshot memory s) {
        int64 szi = core.szi(hedge);
        uint64 mark = core.markPx();
        uint64 ntl = _abs(szi) * mark;
        s = HyperCoreGateway.Snapshot({
            observedAt: uint64(block.timestamp),
            szi: szi,
            entryNtl: core.entryNtl(hedge),
            accountValue: int64(uint64(core.accountValue(hedge))),
            marginUsed: ntl / core.leverage(),
            ntlPos: ntl,
            spotUsdcWei: core.spotWei(hedge),
            oraclePx: core.oraclePx(),
            markPx: mark,
            leverage: core.leverage(),
            exists: core.exists(hedge),
            executedNonce: executed
        });
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

    function _sync() internal {
        vm.prank(keeper);
        vault.syncHedge();
    }

    /// @dev Crash + liquidate + relayer places the short + sync: the vault ends Idle holding SEIZE, short 40_000.
    function _takeAndHedge() internal {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);
        _relay();
        _sync();
    }

    // ─── chain / market control ───────────────────────────────────────────

    function _nextBlock(uint256 secs) internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + secs);
    }

    /// @dev Move both the lending oracle and HyperCore's oracle/mark, and let the relayer report it.
    function _setPrice(uint256 usd6) internal {
        vm.prank(owner);
        oracle.setPrice(usd6 * 1e18);
        core.setPx(_raw(usd6));
        _post(gateway.executedNonce());
    }

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

    // ─── helpers ──────────────────────────────────────────────────────────

    function _raw(uint256 usd6) internal pure returns (uint64) {
        return uint64(usd6 / 10 ** SZ_DEC);
    }

    function _pending() internal view returns (int64 delta, uint8 tries) {
        (delta,,, tries) = vault.pendingHedge();
    }

    function _coreUnits(uint256 nvdaxAmount) internal pure returns (int64) {
        return int64(Units.toCoreSize(nvdaxAmount, SZ_DEC));
    }

    function _abs(int64 x) internal pure returns (uint64) {
        return x >= 0 ? uint64(x) : uint64(-x);
    }
}
