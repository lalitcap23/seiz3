// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {PoolSeeder} from "../src/mocks/PoolSeeder.sol";
import {UnwindLib} from "../src/libs/UnwindLib.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice Initialises the NVDAx/USDC v4 pool (first run) and adds liquidity through PoolSeeder.
/// THIN=true seeds weekend conditions; THIN=false adds the "Monday" deep liquidity. With a `thinPoolKey` in the
/// deployment file (DeployRemote.s.sol writes one), THIN=true seeds market A's separate pool instead of the vault's.
/// The deployer must hold USDC_AMOUNT USDC; NVDAx is minted if the deployer owns MockNVDAx.
///
///   NETWORK=base-sepolia THIN=true forge script script/SeedPool.s.sol --rpc-url $RPC --broadcast
contract SeedPool is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 constant BPS = 10_000;

    struct Config {
        PoolSeeder seeder;
        PoolKey key;
        address usdc;
        address nvdax;
        bool nvdax0;
        bool thin;
        uint256 initPrice; // only used if the pool is new
        uint256 usdcAmount;
        uint256 rangeBps;
    }

    function run() external {
        Config memory c = _config();

        vm.startBroadcast();
        uint160 sqrtPriceX96 = _ensureInitialized(c);
        uint256 price = UnwindLib.usdcPerNvdaxAt(sqrtPriceX96, c.nvdax0);
        uint256 nvdaxAmount = c.usdcAmount * 1e18 / price;
        (int24 tickLower, int24 tickUpper) = _range(price, c.rangeBps, c.nvdax0, c.key.tickSpacing);
        uint128 liquidity = _liquidity(c, sqrtPriceX96, tickLower, tickUpper, nvdaxAmount);

        _fund(c, nvdaxAmount);
        // separate salts so the thin and deep positions can be pulled independently
        c.seeder
            .modifyLiquidity(c.key, tickLower, tickUpper, int256(uint256(liquidity)), bytes32(uint256(c.thin ? 0 : 1)));
        vm.stopBroadcast();

        console.log(c.thin ? "thin liquidity added" : "deep liquidity added", liquidity);
        console.log("pool price (USDC 6 dec per NVDAx)", price);
    }

    function _config() internal view returns (Config memory c) {
        string memory network = vm.envOr("NETWORK", string("base-sepolia"));
        string memory dep = vm.readFile(DeployHelpers.deploymentPath(vm.projectRoot(), network));
        c.seeder = PoolSeeder(vm.parseJsonAddress(dep, ".poolSeeder"));
        c.usdc = vm.parseJsonAddress(dep, ".usdc");
        c.nvdax = vm.parseJsonAddress(dep, ".nvdax");
        c.thin = vm.envOr("THIN", true);
        // weekend depth lives on market A's own hookless pool; the vault's hooked pool gets the Monday depth.
        // Keys come from the deployment file: the vault's names the hook, so it can't be rebuilt from tokens alone.
        c.key = _key(dep, c.thin && vm.keyExistsJson(dep, ".thinPoolKey") ? ".thinPoolKey" : ".poolKey");
        c.nvdax0 = Currency.unwrap(c.key.currency0) == c.nvdax;
        c.initPrice = vm.envOr("PRICE_USD6", uint256(217e6));
        c.usdcAmount = vm.envOr("USDC_AMOUNT", c.thin ? uint256(2000e6) : uint256(200_000e6));
        c.rangeBps = vm.envOr("RANGE_BPS", c.thin ? uint256(300) : uint256(1000));
    }

    function _key(string memory dep, string memory at) internal pure returns (PoolKey memory key) {
        key.currency0 = Currency.wrap(vm.parseJsonAddress(dep, string.concat(at, ".currency0")));
        key.currency1 = Currency.wrap(vm.parseJsonAddress(dep, string.concat(at, ".currency1")));
        key.fee = uint24(vm.parseJsonUint(dep, string.concat(at, ".fee")));
        key.tickSpacing = int24(vm.parseJsonInt(dep, string.concat(at, ".tickSpacing")));
        key.hooks = IHooks(vm.parseJsonAddress(dep, string.concat(at, ".hooks")));
    }

    function _ensureInitialized(Config memory c) internal returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = c.seeder.poolManager().getSlot0(c.key.toId());
        if (sqrtPriceX96 == 0) {
            sqrtPriceX96 = UnwindLib.sqrtPriceAt(c.initPrice, c.nvdax0);
            c.seeder.initialize(c.key, sqrtPriceX96);
        }
    }

    function _liquidity(Config memory c, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint256 nvdaxAmount)
        internal
        pure
        returns (uint128)
    {
        (uint256 amount0, uint256 amount1) = c.nvdax0 ? (nvdaxAmount, c.usdcAmount) : (c.usdcAmount, nvdaxAmount);
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );
    }

    function _fund(Config memory c, uint256 nvdaxAmount) internal {
        (, address deployer,) = vm.readCallers();
        if (IERC20(c.nvdax).balanceOf(deployer) < nvdaxAmount) MockNVDAx(c.nvdax).mint(deployer, nvdaxAmount);
        IERC20(c.usdc).approve(address(c.seeder), c.usdcAmount);
        IERC20(c.nvdax).approve(address(c.seeder), nvdaxAmount);
    }

    /// @dev ±rangeBps around `price`, widened outwards to the tick spacing. Ticks run in currency1/currency0,
    ///      so when NVDAx is currency1 a higher USDC price is a lower tick.
    function _range(uint256 price, uint256 rangeBps, bool nvdax0, int24 spacing)
        internal
        pure
        returns (int24 lower, int24 upper)
    {
        int24 a = TickMath.getTickAtSqrtPrice(UnwindLib.sqrtPriceAt(price * (BPS - rangeBps) / BPS, nvdax0));
        int24 b = TickMath.getTickAtSqrtPrice(UnwindLib.sqrtPriceAt(price * (BPS + rangeBps) / BPS, nvdax0));
        (int24 lo, int24 hi) = a < b ? (a, b) : (b, a);
        lower = _floor(lo, spacing);
        upper = _floor(hi, spacing) + spacing;
    }

    function _floor(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 c = tick / spacing;
        if (tick < 0 && tick % spacing != 0) c--;
        return c * spacing;
    }
}
