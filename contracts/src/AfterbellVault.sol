// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IMorpho, MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {IMorphoLiquidateCallback} from "@morpho-blue/interfaces/IMorphoCallbacks.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {IAfterbellVault} from "./interfaces/IAfterbellVault.sol";
import {RiskParams} from "./RiskParams.sol";
import {HedgeLib} from "./libs/HedgeLib.sol";
import {UnwindLib} from "./libs/UnwindLib.sol";
import {Units} from "./libs/Units.sol";

/// @title AfterbellVault
/// @notice ERC-4626 USDC vault that buys seized stock collateral from Morpho, shorts the same stock on
///         HyperCore (xyz:NVDA) in the same tx, and later unwinds into Uniswap v4 while closing the short.
/// @dev The vault's address is also its HyperCore trading account. Only one hedge order is ever in flight.
contract AfterbellVault is ERC4626, Ownable, IAfterbellVault, IMorphoLiquidateCallback, IUnlockCallback {
    using SafeERC20 for IERC20;

    // ─── immutable wiring ─────────────────────────────────────────────────
    IERC20 public immutable usdc; // 6 dec
    IERC20 public immutable nvdax; // 18 dec
    IMorpho public immutable morpho;
    IPoolManager public immutable poolManager;
    uint32 public immutable perpAsset; // 100000 + perpDexIndex*10000 + indexInMeta
    uint32 public immutable perpDexIndex;
    uint8 public immutable szDecimals;
    bool public immutable nvdaxIsCurrency0;

    PoolKey public poolKey;
    RiskParams public risk;

    // ─── position state ───────────────────────────────────────────────────
    uint256 public inventory;
    int64 public confirmedShort;
    Pending public pendingHedge;
    uint256 public marginFloat;
    uint256 public inTransit;
    bool public paused;
    uint64 public lastUnwindAt;

    // ─── LP state ─────────────────────────────────────────────────────────
    uint256 public queuedShares;
    mapping(address => uint256) public queued;

    // ─── callback guard ───────────────────────────────────────────────────
    bool transient inLiquidation;

    struct Wiring {
        IERC20 usdc;
        IERC20 nvdax;
        IMorpho morpho;
        IPoolManager poolManager;
        PoolKey poolKey;
        RiskParams risk;
        uint32 perpAsset;
        uint32 perpDexIndex;
        uint8 szDecimals; // read from perpAssetInfo precompile off-chain / in deploy script
    }

    constructor(address owner_, Wiring memory w)
        ERC20("Afterbell Vault USDC", "abUSDC")
        ERC4626(w.usdc)
        Ownable(owner_)
    {
        usdc = w.usdc;
        nvdax = w.nvdax;
        morpho = w.morpho;
        poolManager = w.poolManager;
        poolKey = w.poolKey;
        risk = w.risk;
        perpAsset = w.perpAsset;
        perpDexIndex = w.perpDexIndex;
        szDecimals = w.szDecimals;
        nvdaxIsCurrency0 = Currency.unwrap(w.poolKey.currency0) == address(w.nvdax);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6; // first-depositor inflation protection
    }

    // ─── modifiers ────────────────────────────────────────────────────────
    modifier whenIdle() {
        if (paused) revert VaultPaused();
        if (pendingHedge.delta != 0) revert HedgePending();
        _;
    }

    // ─── LP accounting ────────────────────────────────────────────────────

    /// @notice idle USDC + Core account value (incl. uPnL) + inventory × Core oraclePx + in-transit.
    function totalAssets() public view override returns (uint256) {
        // TODO: + marginSummary(perpDexIndex).accountValue + spot USDC + inventory value + inTransit
        return usdc.balanceOf(address(this)) + inTransit;
    }

    function requestWithdraw(uint256 shares) external {
        // TODO: pay instantly from idle (minus withdrawReserve) else move shares into queue
        shares;
        revert("TODO");
    }

    function claimQueued() external {
        // TODO
        revert("TODO");
    }

    // ─── liquidation ──────────────────────────────────────────────────────

    function liquidate(MarketParams calldata params, address borrower, uint256 seized) external whenIdle {
        // TODO pre-checks: notional ≤ maxLiquidation, marginFloat ≥ notional/leverage×(1+buffer), oracle band
        inLiquidation = true;
        morpho.liquidate(params, borrower, seized, 0, abi.encode(keccak256(abi.encode(borrower, block.number)), seized));
        inLiquidation = false;
    }

    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert NotMorpho();
        if (!inLiquidation) revert NotInLiquidation();
        (bytes32 liqId, uint256 seized) = abi.decode(data, (bytes32, uint256));
        // TODO: inventory += seized; discount floor; HedgeLib.limitOrderIoc(sell); record pendingHedge;
        //       emit LiquidationTaken
        liqId;
        seized;
        usdc.forceApprove(address(morpho), repaidAssets);
    }

    // ─── hedge ────────────────────────────────────────────────────────────

    function syncHedge() external {
        Pending memory p = pendingHedge;
        if (block.number <= p.sentBlock) revert SameBlock();
        // TODO: see architecture doc §Hedge confirmation
        revert("TODO");
    }

    function topUpMargin(uint256 amount) external {
        // TODO: CoreDepositWallet deposit to perp / xyz dex; inTransit += amount; emit MarginMoved
        amount;
        revert("TODO");
    }

    function withdrawMargin(uint256 amount) external {
        // TODO: only when inventory == 0 && confirmedShort == 0; spot send to USDC system address
        amount;
        revert("TODO");
    }

    // ─── unwind ───────────────────────────────────────────────────────────

    function unwindStep() external whenIdle {
        // TODO: cooldown, pool-vs-oracle band, chunk size, minOut, reduce-only buy, pendingHedge
        revert("TODO");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 amountIn, uint256 minOut) = abi.decode(data, (uint256, uint256));
        uint256 out = UnwindLib.swapExactIn(poolManager, poolKey, nvdaxIsCurrency0, amountIn);
        if (out < minOut) revert Slippage();
        return abi.encode(out);
    }

    // ─── admin ────────────────────────────────────────────────────────────

    function setRisk(RiskParams r) external onlyOwner {
        risk = r;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }

    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}
