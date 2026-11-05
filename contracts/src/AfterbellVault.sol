// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IMorpho, MarketParams, Id} from "@morpho-blue/interfaces/IMorpho.sol";
import {IMorphoLiquidateCallback} from "@morpho-blue/interfaces/IMorphoCallbacks.sol";
import {IOracle} from "@morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "@morpho-blue/libraries/MarketParamsLib.sol";

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
///      Pausing stops new risk (`liquidate`, deposits). `unwindStep` reduces risk, so it still runs while the
///      vault is paused for low margin (that is how it raises cash), but never during an owner pause or with
///      an unconfirmed hedge. `syncHedge` always runs.
contract AfterbellVault is
    ERC4626,
    Ownable,
    ReentrancyGuardTransient,
    IAfterbellVault,
    IMorphoLiquidateCallback,
    IUnlockCallback
{
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;

    // ─── pause flags ──────────────────────────────────────────────────────
    uint8 public constant PAUSE_HEDGE = 1; // hedge not confirmed after maxTries; cleared by a matching sync
    uint8 public constant PAUSE_MARGIN = 2; // perp margin below buffer; cleared by a sync once topped up
    uint8 public constant PAUSE_OWNER = 4; // emergency stop; only `unpause` clears it

    uint256 internal constant BPS = 10_000;
    /// @dev Non-owners may top margin up to 110% of `marginTarget()`.
    uint256 internal constant TOPUP_SLACK_BPS = 1000;

    // ─── immutable wiring ─────────────────────────────────────────────────
    IERC20 public immutable usdc; // 6 dec
    IERC20 public immutable nvdax; // 18 dec
    IMorpho public immutable morpho;
    IPoolManager public immutable poolManager;
    address public immutable coreDepositWallet; // Circle's HyperEVM → HyperCore USDC entry
    uint32 public immutable perpAsset; // order id: 100000 + perpDexIndex*10000 + indexInMeta
    uint32 public immutable perpIndex; // precompile read id: perpDexIndex*10000 + indexInMeta
    uint32 public immutable perpDexIndex;
    uint8 public immutable szDecimals;
    bool public immutable nvdaxIsCurrency0;

    PoolKey public poolKey;
    RiskParams public risk;

    // ─── position state ───────────────────────────────────────────────────
    uint256 public inventory; // NVDAx held as hedged inventory, 18 dec
    int64 public confirmedShort; // last szi read from the position precompile (negative = short)
    Pending public pendingHedge; // last order sent but not yet seen
    bytes32 public hedgeId; // current hedge cycle; cloid = keccak(hedgeId, tries)
    uint256 public hedgeNonce;
    uint256 public marginFloat; // USDC (6 dec) on the xyz perp account incl. in-flight deposits, refreshed on sync
    uint8 public pauseFlags;
    uint64 public lastUnwindAt;
    uint32 public marginDepositDex; // CoreDepositWallet destination for top-ups: perpDexIndex or SPOT_DEX
    bool public coreFunded; // set by the first deposit to Core; until then there is nothing on Core to read
    mapping(Id => bool) public marketAllowed;

    uint256 internal _transitAmount; // USDC sent HyperEVM → HyperCore, not yet visible in precompile reads
    uint64 internal _transitUntilBlock;

    // ─── LP state ─────────────────────────────────────────────────────────
    uint256 public queuedShares; // shares waiting in the withdrawal queue (held by the vault itself)
    mapping(address => uint256) public queued;

    // ─── callback guards (transient storage) ──────────────────────────────
    bool transient inLiquidation;
    bool transient inUnwind;

    struct Wiring {
        IERC20 usdc;
        IERC20 nvdax;
        IMorpho morpho;
        IPoolManager poolManager;
        PoolKey poolKey;
        RiskParams risk;
        address coreDepositWallet;
        uint32 perpAsset;
        uint32 perpDexIndex;
        uint8 szDecimals; // read from the perpAssetInfo precompile / info API in the deploy script
    }

    constructor(address owner_, Wiring memory w)
        ERC20("Afterbell Vault USDC", "abUSDC")
        ERC4626(w.usdc)
        Ownable(owner_)
    {
        address c0 = Currency.unwrap(w.poolKey.currency0);
        address c1 = Currency.unwrap(w.poolKey.currency1);
        bool nvdax0 = c0 == address(w.nvdax) && c1 == address(w.usdc);
        uint32 index = HedgeLib.perpIndexOf(w.perpAsset);
        if (
            IERC20Metadata(address(w.usdc)).decimals() != Units.USDC_DECIMALS
                || IERC20Metadata(address(w.nvdax)).decimals() != Units.NVDAX_DECIMALS
                || (!nvdax0 && !(c0 == address(w.usdc) && c1 == address(w.nvdax)))
                || w.szDecimals > Units.PERP_PX_DECIMALS || address(w.risk) == address(0)
                || w.coreDepositWallet == address(0)
                || (w.perpAsset >= HedgeLib.HIP3_ASSET_OFFSET && index / 10_000 != w.perpDexIndex)
        ) revert BadWiring();

        usdc = w.usdc;
        nvdax = w.nvdax;
        morpho = w.morpho;
        poolManager = w.poolManager;
        coreDepositWallet = w.coreDepositWallet;
        poolKey = w.poolKey;
        risk = w.risk;
        perpAsset = w.perpAsset;
        perpIndex = index;
        perpDexIndex = w.perpDexIndex;
        szDecimals = w.szDecimals;
        nvdaxIsCurrency0 = nvdax0;
        marginDepositDex = w.perpDexIndex;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6; // first-depositor inflation protection
    }

    // ═══ LP accounting ═════════════════════════════════════════════════════

    /// @notice idle USDC + Core USDC (xyz account value incl. uPnL, plus Core spot) + inventory × Core oraclePx
    ///         + USDC in transit to Core. Reverts if a precompile read fails, so share math fails closed.
    function totalAssets() public view override returns (uint256 assets) {
        assets = usdc.balanceOf(address(this)) + coreUsdc() + inTransit();
        uint256 inv = inventory;
        if (inv != 0) assets += Units.value(inv, _corePxUsdc(HedgeLib.oraclePx(perpIndex)));
    }

    /// @notice USDC the vault holds on HyperCore: account value on the xyz DEX (already includes the short's
    ///         uPnL) plus any spot USDC. Zero before the first deposit to Core, which also keeps the seed
    ///         deposit free of precompile reads (forge scripts run in a plain EVM).
    function coreUsdc() public view returns (uint256) {
        if (!coreFunded) return 0;
        uint256 spot = Units.spotWeiToUsdc(HedgeLib.spotBalance(address(this), HedgeLib.USDC_TOKEN).total);
        return _dexAccountValue() + spot;
    }

    /// @notice USDC deposited to Core in the last `transitBlocks` blocks: gone from the EVM balance, not yet
    ///         in precompile reads. Core → EVM needs no entry: the Core debit and the EVM credit land together.
    function inTransit() public view returns (uint256) {
        return block.number < _transitUntilBlock ? _transitAmount : 0;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        return pauseFlags != 0 ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return pauseFlags != 0 ? 0 : super.maxMint(receiver);
    }

    /// @notice Instant withdrawals are capped at idle USDC minus the margin reserve and what queued LPs are owed.
    function maxWithdraw(address holder) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(holder), instantLiquidity());
    }

    function maxRedeem(address holder) public view override returns (uint256) {
        return Math.min(super.maxRedeem(holder), _convertToShares(instantLiquidity(), Math.Rounding.Floor));
    }

    /// @notice USDC available to instant withdrawals right now. Queued LPs are paid first.
    function instantLiquidity() public view returns (uint256) {
        uint256 free = _freeIdle();
        uint256 owed = queuedShares == 0 ? 0 : _convertToAssets(queuedShares, Math.Rounding.Ceil);
        return free > owed ? free - owed : 0;
    }

    /// @notice Redeem now if idle USDC covers it; otherwise lock the shares in the queue. Queued shares stay in
    ///         `totalSupply`, so they keep sharing gains and losses until `claimQueued` prices and pays them.
    function requestWithdraw(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        if (shares > balanceOf(msg.sender)) revert ExceedsBalance();

        if (shares <= maxRedeem(msg.sender)) {
            _withdraw(msg.sender, msg.sender, msg.sender, previewRedeem(shares), shares);
            return;
        }
        _transfer(msg.sender, address(this), shares);
        queued[msg.sender] += shares;
        queuedShares += shares;
        emit WithdrawQueued(msg.sender, shares);
    }

    /// @notice Pay out as much of the caller's queue as free idle USDC allows, at the current share price.
    function claimQueued() external nonReentrant {
        uint256 shares = queued[msg.sender];
        if (shares == 0) revert NothingToClaim();

        uint256 free = _freeIdle();
        uint256 assets = previewRedeem(shares);
        if (assets > free) {
            shares = _convertToShares(free, Math.Rounding.Floor);
            assets = previewRedeem(shares);
        }
        if (shares == 0 || assets == 0) revert NothingToClaim();

        queued[msg.sender] -= shares;
        queuedShares -= shares;
        _burn(address(this), shares);
        usdc.safeTransfer(msg.sender, assets);
        emit Withdraw(msg.sender, msg.sender, msg.sender, assets, shares);
        emit WithdrawClaimed(msg.sender, shares, assets);
    }

    // ═══ liquidation ═══════════════════════════════════════════════════════

    /// @notice Buy `seized` NVDAx from an unhealthy Morpho borrower and short the same size on HyperCore.
    ///         Every check that can fail runs before Morpho is touched.
    function liquidate(MarketParams calldata params, address borrower, uint256 seized) external nonReentrant {
        MarketParams memory mp = params;
        (uint64 sz, uint64 corePx) = _preLiquidate(mp, seized);

        bytes32 id = _newHedgeId();
        inLiquidation = true;
        (, uint256 repaid) = morpho.liquidate(mp, borrower, seized, 0, abi.encode(id, seized, corePx));
        inLiquidation = false;

        emit LiquidationTaken(id, borrower, seized, repaid, -int64(sz), HedgeLib.makeCloid(id, 1));
    }

    /// @notice Morpho has already sent the collateral; it pulls `repaidAssets` USDC once this returns.
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert NotMorpho();
        if (!inLiquidation) revert NotInLiquidation();
        inLiquidation = false; // one callback per liquidation

        (bytes32 id, uint256 seized, uint64 corePx) = abi.decode(data, (bytes32, uint256, uint64));
        RiskParams.Params memory r = risk.get();

        inventory += seized;

        // Morpho's bonus comes from LLTV; this floor only guards against a mispriced market.
        uint256 seizedValue = Units.value(seized, _corePxUsdc(corePx));
        if (repaidAssets * BPS > seizedValue * (BPS - r.minDiscountBps)) revert DiscountTooLow();
        if (usdc.balanceOf(address(this)) < repaidAssets + r.withdrawReserve) revert ExceedsIdle();

        hedgeId = id;
        _sendHedge(-int64(Units.toCoreSize(seized, szDecimals)), corePx, 1, r);

        usdc.forceApprove(address(morpho), repaidAssets);
    }

    // ═══ hedge ═════════════════════════════════════════════════════════════

    /// @notice The vault's only way to learn what HyperCore did. Aims at `−inventory`, so a dropped
    ///         liquidation order, a dropped unwind order and a double fill all heal the same way.
    function syncHedge() external nonReentrant {
        Pending memory p = pendingHedge;
        RiskParams.Params memory r = risk.get();
        if (p.delta != 0) {
            if (block.number <= p.sentBlock) revert SameBlock();
            if (block.timestamp < uint256(p.sentAt) + r.orderDelaySec) revert TooEarly();
        }

        int64 actual = HedgeLib.position(address(this), perpIndex).szi;
        confirmedShort = actual;
        int64 target = _target();
        int64 gap = target - actual; // < 0: need more short, > 0: over-short

        uint64 corePx = HedgeLib.oraclePx(perpIndex);
        _checkMargin(actual, corePx, r);

        if (_isHedged(gap, r)) {
            if (p.delta != 0) {
                delete pendingHedge;
                emit HedgeConfirmed(actual, target);
            }
            _clearPause(PAUSE_HEDGE);
            return;
        }

        uint8 tries;
        if (p.delta == 0) {
            // drift found while idle (e.g. Core liquidated the short): start a new hedge cycle
            hedgeId = _newHedgeId();
            tries = 1;
        } else {
            if (p.tries >= r.maxTries) {
                _setPause(PAUSE_HEDGE);
                emit HedgeStuck(gap);
            }
            tries = p.tries == type(uint8).max ? p.tries : p.tries + 1;
        }
        _sendHedge(gap, corePx, tries, r);
    }

    /// @notice Move idle USDC to the perp account through CoreDepositWallet. Anyone may call it, but only
    ///         the owner may go past 110% of `marginTarget()`.
    function topUpMargin(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > usdc.balanceOf(address(this))) revert ExceedsIdle();
        if (!HedgeLib.coreUserExists(address(this))) revert CoreAccountMissing();
        if (msg.sender != owner()) {
            uint256 cap = marginTarget() * (BPS + TOPUP_SLACK_BPS) / BPS;
            if (_dexAccountValue() + inTransit() + amount > cap) revert OverTarget();
        }

        uint32 dex = marginDepositDex;
        _depositToCore(amount, dex);
        if (dex == HedgeLib.SPOT_DEX) {
            // Two-hop route. Core credits EVM deposits before it runs the block's CoreWriter actions (VERIFY);
            // if this hop is dropped the USDC waits on Core spot for `sweepSpotToDex`.
            HedgeLib.sendAsset(
                address(this), HedgeLib.SPOT_DEX, perpDexIndex, HedgeLib.USDC_TOKEN, Units.usdcToSpotWei(amount)
            );
        }
        emit MarginMoved(amount, true);
    }

    /// @notice Core → EVM, only once flat. Arrival is async; the next `claimQueued` sees the new idle balance.
    function withdrawMargin(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (inventory != 0 || pendingHedge.delta != 0) revert NotFlat();
        if (HedgeLib.position(address(this), perpIndex).szi != 0) revert NotFlat();
        if (amount > _dexAccountValue()) revert ExceedsCore();

        uint64 amountWei = Units.usdcToSpotWei(amount);
        HedgeLib.sendAsset(address(this), perpDexIndex, HedgeLib.SPOT_DEX, HedgeLib.USDC_TOKEN, amountWei);
        HedgeLib.spotSend(HedgeLib.USDC_SYSTEM_ADDRESS, HedgeLib.USDC_TOKEN, amountWei);
        emit MarginMoved(amount, false);
    }

    /// @notice Move USDC sitting on the vault's Core spot balance onto the xyz DEX (activation leftovers, a
    ///         dropped second hop). Only adds margin, so anyone may call it.
    function sweepSpotToDex() external nonReentrant {
        uint64 bal = HedgeLib.spotBalance(address(this), HedgeLib.USDC_TOKEN).total;
        uint64 amountWei = bal - bal % uint64(Units.SPOT_WEI_PER_USDC); // whole perp units only
        if (amountWei == 0) revert ZeroAmount();
        HedgeLib.sendAsset(address(this), HedgeLib.SPOT_DEX, perpDexIndex, HedgeLib.USDC_TOKEN, amountWei);
        emit CoreUsdcSwept(amountWei);
    }

    // ═══ unwind ════════════════════════════════════════════════════════════

    /// @notice Sell one chunk of NVDAx into v4 and queue a reduce-only buy of the short it no longer needs.
    /// @dev chunk ≤ maxUnhedged keeps the brief over-hedge (stock sold, buy not landed) inside the invariant.
    ///      The swap's price limit caps impact at `maxImpactBps`; `minOut` is measured against the Core oracle,
    ///      the price the short is bought back at.
    function unwindStep() external nonReentrant {
        if (pauseFlags & PAUSE_OWNER != 0) revert VaultPaused();
        if (pendingHedge.delta != 0) revert HedgePending();
        uint256 inv = inventory;
        if (inv == 0) revert NoInventory();
        RiskParams.Params memory r = risk.get();
        if (block.timestamp < uint256(lastUnwindAt) + risk.cooldown()) revert Cooldown();

        uint64 corePx = HedgeLib.oraclePx(perpIndex);
        uint256 pxUsdc = _corePxUsdc(corePx);
        (uint160 sqrtPriceX96, uint256 poolPx) = UnwindLib.poolPrice(poolManager, poolKey, nvdaxIsCurrency0);
        if (Units.diffBps(poolPx, pxUsdc) > r.oracleBandBps) revert OracleBand();

        // never sell stock the short doesn't cover: the confirmed hedge must still be in place on Core
        int64 actual = HedgeLib.position(address(this), perpIndex).szi;
        if (_abs(_target() - actual) > r.maxUnhedged) revert HedgeDrift();

        uint256 chunk = Math.min(inv, Units.fromCoreSize(r.maxUnhedged, szDecimals));
        uint160 limit = UnwindLib.impactLimit(sqrtPriceX96, r.maxImpactBps, nvdaxIsCurrency0);
        inUnwind = true;
        (uint256 sold, uint256 usdcOut) = abi.decode(poolManager.unlock(abi.encode(chunk, limit)), (uint256, uint256));
        inUnwind = false;
        if (sold == 0) revert NothingSold();
        if (usdcOut * BPS < Units.value(sold, pxUsdc) * (BPS - r.maxSlippageBps)) revert Slippage();

        inventory = inv - sold;
        lastUnwindAt = uint64(block.timestamp);
        confirmedShort = actual;

        int64 gap = _target() - actual; // > 0: short is now bigger than the stock left
        if (gap > 0) {
            hedgeId = _newHedgeId();
            _sendHedge(gap, corePx, 1, r);
        }
        emit Unwound(sold, usdcOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!inUnwind) revert NotInUnwind();
        (uint256 amountIn, uint160 limit) = abi.decode(data, (uint256, uint160));
        (uint256 sold, uint256 out) = UnwindLib.swapExactIn(poolManager, poolKey, nvdaxIsCurrency0, amountIn, limit);
        return abi.encode(sold, out);
    }

    // ═══ views ═════════════════════════════════════════════════════════════

    function paused() external view returns (bool) {
        return pauseFlags != 0;
    }

    function hedgeState() external view returns (HedgeState) {
        if (pauseFlags != 0) return HedgeState.Paused;
        Pending memory p = pendingHedge;
        if (p.delta == 0) return HedgeState.Idle;
        return p.tries > 1 ? HedgeState.Retrying : HedgeState.Pending;
    }

    /// @notice True when the keeper's `syncHedge` would not revert on timing.
    function canSync() external view returns (bool) {
        Pending memory p = pendingHedge;
        return
            p.delta != 0 && block.number > p.sentBlock
                && block.timestamp >= uint256(p.sentAt) + risk.get().orderDelaySec;
    }

    /// @notice Margin to hold the target short plus one max-size liquidation, with buffer.
    function marginTarget() public view returns (uint256) {
        RiskParams.Params memory r = risk.get();
        uint256 targetNotional = inventory == 0 ? 0 : Units.value(inventory, _corePxUsdc(HedgeLib.oraclePx(perpIndex)));
        return _requiredMargin(targetNotional + r.maxLiquidation, r);
    }

    /// @notice USDC the keeper should top up to restore the buffer on the target short (add 10% on top).
    function marginShortfall() external view returns (uint256) {
        if (inventory == 0) return 0;
        RiskParams.Params memory r = risk.get();
        uint256 required = _requiredMargin(Units.value(inventory, _corePxUsdc(HedgeLib.oraclePx(perpIndex))), r);
        uint256 have = _dexAccountValue() + inTransit();
        return required > have ? required - have : 0;
    }

    // ═══ admin ═════════════════════════════════════════════════════════════

    function setRisk(RiskParams r) external onlyOwner {
        if (address(r) == address(0)) revert BadWiring();
        risk = r;
        emit RiskSet(address(r));
    }

    /// @notice Only allow-listed markets can be liquidated: anyone can create a Morpho market with any oracle.
    function setMarketAllowed(MarketParams calldata params, bool allowed) external onlyOwner {
        if (params.loanToken != address(usdc) || params.collateralToken != address(nvdax)) revert BadMarket();
        MarketParams memory mp = params;
        Id id = mp.id();
        marketAllowed[id] = allowed;
        emit MarketAllowed(Id.unwrap(id), allowed);
    }

    /// @notice VERIFY (open question 2): perpDexIndex = CoreDepositWallet credits xyz directly;
    ///         SPOT_DEX = deposit to spot, then `sendAsset` spot → xyz.
    function setMarginDepositDex(uint32 dex) external onlyOwner {
        if (dex != perpDexIndex && dex != HedgeLib.SPOT_DEX) revert BadDex();
        marginDepositDex = dex;
        emit MarginDepositDexSet(dex);
    }

    /// @notice Create the vault's HyperCore account: deposit a few USDC to Core spot (1 USDC activation fee),
    ///         wait for `coreUserExists`, then `sweepSpotToDex` / `topUpMargin`.
    function activateCore(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > usdc.balanceOf(address(this))) revert ExceedsIdle();
        _depositToCore(amount, HedgeLib.SPOT_DEX);
        emit MarginMoved(amount, true);
    }

    /// @notice Agent wallet for the L1 actions CoreWriter lacks (e.g. leverage / isolated margin on xyz).
    ///         Agents can trade but not withdraw. VERIFY whether the spike needs it at all.
    function addApiWallet(address wallet, string calldata name) external onlyOwner {
        HedgeLib.addApiWallet(wallet, name);
        emit ApiWalletAdded(wallet, name);
    }

    function pause() external onlyOwner {
        _setPause(PAUSE_OWNER);
    }

    /// @notice Manual override: clears every flag. A sync re-pauses if the hedge or margin is still bad.
    function unpause() external onlyOwner {
        _clearPause(PAUSE_HEDGE | PAUSE_MARGIN | PAUSE_OWNER);
    }

    /// @notice Recover stray tokens. LP USDC, vault shares and hedged inventory are off limits.
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (address(token) == address(usdc) || address(token) == address(this)) revert NotRescuable();
        if (address(token) == address(nvdax) && amount + inventory > nvdax.balanceOf(address(this))) {
            revert NotRescuable();
        }
        token.safeTransfer(to, amount);
    }

    // ═══ internals ═════════════════════════════════════════════════════════

    /// @dev The liquidation pre-checks: not paused, no hedge in flight, allow-listed market, Core account live,
    ///      notional ≤ cap, lending oracle within band of the Core oracle, margin for the short after this one.
    function _preLiquidate(MarketParams memory mp, uint256 seized) internal returns (uint64 sz, uint64 corePx) {
        if (pauseFlags != 0) revert VaultPaused();
        if (pendingHedge.delta != 0) revert HedgePending();
        if (!marketAllowed[mp.id()]) revert MarketNotAllowed();

        RiskParams.Params memory r = risk.get();
        sz = Units.toCoreSize(seized, szDecimals);
        if (sz == 0) revert ZeroSize();
        if (!HedgeLib.coreUserExists(address(this))) revert CoreAccountMissing();

        corePx = HedgeLib.oraclePx(perpIndex);
        uint256 pxUsdc = _corePxUsdc(corePx);
        uint256 notional = Units.value(seized, pxUsdc);
        if (notional > r.maxLiquidation) revert OverCap();
        if (Units.diffBps(Units.morphoPxToUsdc(IOracle(mp.oracle).price()), pxUsdc) > r.oracleBandBps) {
            revert OracleBand();
        }

        uint256 margin = _dexAccountValue() + inTransit();
        marginFloat = margin;
        if (margin < _requiredMargin(_shortNotional(confirmedShort, pxUsdc) + notional, r)) revert LowMargin();
    }

    /// @dev Sends one IOC order of `delta` (negative = sell / more short) priced `hedgeCapBps` off the oracle,
    ///      and records it as the single hedge in flight. Every buy is reduce-only: the vault is only ever short,
    ///      so a late double fill can never flip it long.
    function _sendHedge(int64 delta, uint64 corePx, uint8 tries, RiskParams.Params memory r) internal {
        bool isBuy = delta > 0;
        uint64 wirePx = Units.pxToWire(Units.offsetPx(corePx, r.hedgeCapBps, isBuy, szDecimals), szDecimals);
        uint128 cloid = HedgeLib.makeCloid(hedgeId, tries);
        HedgeLib.limitOrderIoc(perpAsset, isBuy, wirePx, Units.sizeToWire(_abs(delta), szDecimals), isBuy, cloid);
        pendingHedge = Pending(delta, uint64(block.number), uint64(block.timestamp), tries);
        emit HedgeSent(delta, wirePx, isBuy, tries, cloid);
    }

    /// @dev Refreshes `marginFloat` and sets or clears PAUSE_MARGIN for the short as it stands on Core.
    function _checkMargin(int64 actual, uint64 corePx, RiskParams.Params memory r) internal {
        uint256 value = _dexAccountValue() + inTransit();
        uint256 required = _requiredMargin(_shortNotional(actual, _corePxUsdc(corePx)), r);
        bool ok = value >= required;
        marginFloat = value;
        if (ok) _clearPause(PAUSE_MARGIN);
        else _setPause(PAUSE_MARGIN);
        emit MarginChecked(value, required, ok);
    }

    function _depositToCore(uint256 amount, uint32 dex) internal {
        coreFunded = true;
        if (block.number < _transitUntilBlock) {
            _transitAmount += amount;
        } else {
            _transitAmount = amount;
        }
        _transitUntilBlock = uint64(block.number + risk.get().transitBlocks);
        HedgeLib.depositUsdc(usdc, coreDepositWallet, amount, dex);
    }

    function _setPause(uint8 flag) internal {
        uint8 before = pauseFlags;
        if (before & flag == flag) return;
        pauseFlags = before | flag;
        if (before == 0) emit Paused(true);
    }

    function _clearPause(uint8 flag) internal {
        uint8 before = pauseFlags;
        if (before & flag == 0) return;
        uint8 next = before & ~flag;
        pauseFlags = next;
        if (next == 0) emit Paused(false);
    }

    function _newHedgeId() internal returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), ++hedgeNonce));
    }

    /// @dev Where the short should be: −inventory in Core size units.
    function _target() internal view returns (int64) {
        return -int64(Units.toCoreSize(inventory, szDecimals));
    }

    /// @dev With stock left, a gap within maxUnhedged is hedged. With none, only a fully closed short is.
    function _isHedged(int64 gap, RiskParams.Params memory r) internal view returns (bool) {
        return inventory == 0 ? gap == 0 : _abs(gap) <= r.maxUnhedged;
    }

    /// @dev Isolated margin on a HIP-3 DEX: account value there already includes the position's uPnL.
    function _dexAccountValue() internal view returns (uint256) {
        int64 v = HedgeLib.marginSummary(perpDexIndex, address(this)).accountValue;
        return v > 0 ? uint256(uint64(v)) : 0;
    }

    function _freeIdle() internal view returns (uint256) {
        uint256 idle = usdc.balanceOf(address(this));
        bool exposed = inventory != 0 || confirmedShort != 0 || pendingHedge.delta != 0;
        uint256 reserve = exposed ? risk.get().withdrawReserve : 0;
        return idle > reserve ? idle - reserve : 0;
    }

    function _corePxUsdc(uint64 corePx) internal view returns (uint256) {
        return Units.pxToUsdc(corePx, szDecimals);
    }

    function _shortNotional(int64 szi, uint256 pxUsdc) internal view returns (uint256) {
        return Units.value(Units.fromCoreSize(_abs(szi), szDecimals), pxUsdc);
    }

    function _requiredMargin(uint256 notional, RiskParams.Params memory r) internal pure returns (uint256) {
        return notional * (BPS + r.marginBufferBps) / (uint256(r.leverage) * BPS);
    }

    function _abs(int64 x) internal pure returns (uint64) {
        return x >= 0 ? uint64(x) : uint64(-(x + 1)) + 1;
    }
}
