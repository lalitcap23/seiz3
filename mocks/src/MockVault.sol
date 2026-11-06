// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAfterbellVaultMock} from "./interfaces/IAfterbellVault.sol";
import {IMockMorpho} from "./MockMorpho.sol";

contract MockVault is IAfterbellVaultMock {
    enum FillMode {
        NONE,
        PARTIAL,
        FULL
    }

    uint256 private constant PRICE_SCALE = 1e36;
    uint256 private constant USDC = 1e6;

    address public owner;
    address public immutable keeper;
    IMockMorpho public immutable morpho;
    bytes32 public immutable marketId;
    uint8 public constant szDecimals = 2;
    uint32 public immutable cooldownOpenSec;

    Risk public risk;
    Pending public pendingHedge;

    uint256 public inventory;
    int64 public confirmedShort;
    bool public paused;
    uint64 public lastUnwindAt;

    uint256 public idleUsdc;
    uint256 public coreUsdc;
    uint256 public marginRatioBps;
    bool public marketOpen;
    bool public poolPriceInBand;

    bool public revertAll;
    FillMode public fillMode;

    event PausedSet(bool paused);
    event MarketOpenSet(bool open);
    event PoolPriceInBandSet(bool inBand);
    event FillModeSet(FillMode mode);
    event RevertAllSet(bool revertAll);
    event StateSet(uint256 inventory, int64 confirmedShort, uint256 idleUsdc, uint256 coreUsdc);

    modifier onlyOwner() {
        require(msg.sender == owner, "vault: not owner");
        _;
    }

    modifier onlyKeeper() {
        require(msg.sender == keeper, "vault: not keeper");
        _;
    }

    modifier notReverting() {
        require(!revertAll, "mock: reverted");
        _;
    }

    modifier whenIdle() {
        require(!paused, "vault: paused");
        require(pendingHedge.delta == 0, "vault: hedge pending");
        _;
    }

    constructor(
        address morpho_,
        bytes32 marketId_,
        address keeper_,
        uint256 idleUsdc_,
        uint256 coreUsdc_,
        Risk memory risk_
    ) {
        require(morpho_ != address(0), "vault: zero morpho");
        require(keeper_ != address(0), "vault: zero keeper");
        owner = msg.sender;
        morpho = IMockMorpho(morpho_);
        marketId = marketId_;
        keeper = keeper_;
        idleUsdc = idleUsdc_;
        coreUsdc = coreUsdc_;
        risk = risk_;
        cooldownOpenSec = 2;
        marginRatioBps = 5000;
        marketOpen = true;
        poolPriceInBand = true;
        fillMode = FillMode.FULL;
    }

    function depositIdle(uint256 amount) external {
        idleUsdc += amount;
    }

    function liquidate(bytes32 marketId_, address borrower, uint256 seizedAssets)
        external
        onlyKeeper
        notReverting
        whenIdle
    {
        require(marketId_ == marketId, "vault: market mismatch");
        require(seizedAssets > 0, "vault: zero seize");

        (uint256 seized, uint256 repaid) = morpho.liquidate(borrower, seizedAssets);
        require(idleUsdc >= repaid, "vault: insufficient idle");

        idleUsdc -= repaid;
        inventory += seized;

        int64 coreSize = _coreSize(seized);
        pendingHedge = Pending({
            delta: -coreSize,
            sentBlock: uint64(block.number),
            sentAt: uint64(block.timestamp),
            tries: 1
        });

        emit LiquidationTaken(marketId, borrower, seized, repaid);
        emit HedgeSent(-coreSize, 1);
    }

    function syncHedge() external onlyKeeper notReverting {
        Pending memory p = pendingHedge;
        require(p.delta != 0, "vault: no pending hedge");
        require(block.number > p.sentBlock, "mock: too early");
        require(block.timestamp >= uint256(p.sentAt) + risk.orderDelaySec, "mock: order delay");

        if (fillMode == FillMode.FULL) {
            _applyFill(p.delta);
            pendingHedge = Pending({delta: 0, sentBlock: 0, sentAt: 0, tries: p.tries});
            emit HedgeConfirmed(p.delta, 0);
            return;
        }

        p.tries += 1;
        p.sentBlock = uint64(block.number);
        p.sentAt = uint64(block.timestamp);

        if (fillMode == FillMode.PARTIAL) {
            int64 half = p.delta / 2;
            if (half != 0) _applyFill(half);
            pendingHedge = p;
            emit HedgeConfirmed(half, p.delta);
            return;
        }

        pendingHedge = p;
        if (p.tries >= risk.maxTries) {
            paused = true;
            emit PausedSet(true);
            emit HedgeStuck(p.delta);
        }
    }

    function unwindStep() external onlyKeeper notReverting whenIdle {
        require(inventory > 0, "vault: no inventory");
        uint256 cooldown = marketOpen ? cooldownOpenSec : risk.unwindCooldownSec;
        if (lastUnwindAt != 0) {
            require(block.timestamp >= uint256(lastUnwindAt) + cooldown, "vault: cooldown");
        }

        uint256 chunk = inventory;
        uint256 proceeds = chunk * morpho.price() / PRICE_SCALE;
        int64 coreChunk = _coreSize(chunk);

        inventory -= chunk;
        idleUsdc += proceeds;
        confirmedShort += coreChunk;
        lastUnwindAt = uint64(block.timestamp);

        emit Unwound(chunk, proceeds);
        emit HedgeConfirmed(-coreChunk, 0);
    }

    function topUpMargin(uint256 amount) external onlyKeeper notReverting {
        require(amount > 0, "vault: zero amount");
        require(idleUsdc >= amount, "vault: insufficient idle");

        idleUsdc -= amount;
        coreUsdc += amount;
        marginRatioBps += amount / USDC;

        emit MarginMoved(int256(amount));
    }

    function withdrawMargin(uint256 amount) external onlyKeeper notReverting {
        require(inventory == 0 && confirmedShort == 0, "vault: position open");
        require(amount > 0, "vault: zero amount");
        require(coreUsdc >= amount, "vault: insufficient core");

        coreUsdc -= amount;
        idleUsdc += amount;
        uint256 bps = amount / USDC;
        marginRatioBps = bps >= marginRatioBps ? 0 : marginRatioBps - bps;

        emit MarginMoved(-int256(amount));
    }

    function setRisk(Risk calldata risk_) external onlyOwner {
        risk = risk_;
    }

    function setState(
        uint256 inventory_,
        int64 confirmedShort_,
        uint256 idleUsdc_,
        uint256 coreUsdc_,
        uint256 marginRatioBps_,
        bool paused_
    ) external onlyOwner {
        inventory = inventory_;
        confirmedShort = confirmedShort_;
        idleUsdc = idleUsdc_;
        coreUsdc = coreUsdc_;
        marginRatioBps = marginRatioBps_;
        paused = paused_;
        emit StateSet(inventory_, confirmedShort_, idleUsdc_, coreUsdc_);
    }

    function setInventory(uint256 inventory_) external onlyOwner {
        inventory = inventory_;
    }

    function setConfirmedShort(int64 confirmedShort_) external onlyOwner {
        confirmedShort = confirmedShort_;
    }

    function setIdleUsdc(uint256 idleUsdc_) external onlyOwner {
        idleUsdc = idleUsdc_;
    }

    function setCoreUsdc(uint256 coreUsdc_) external onlyOwner {
        coreUsdc = coreUsdc_;
    }

    function setMarginRatio(uint256 bps) external onlyOwner {
        marginRatioBps = bps;
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setMarketOpen(bool open) external onlyOwner {
        marketOpen = open;
        emit MarketOpenSet(open);
    }

    function setPoolPriceInBand(bool inBand) external onlyOwner {
        poolPriceInBand = inBand;
        emit PoolPriceInBandSet(inBand);
    }

    function setFillMode(FillMode mode) external onlyOwner {
        fillMode = mode;
        emit FillModeSet(mode);
    }

    function setRevertAll(bool revert_) external onlyOwner {
        revertAll = revert_;
        emit RevertAllSet(revert_);
    }

    function setLastUnwindAt(uint64 timestamp) external onlyOwner {
        lastUnwindAt = timestamp;
    }

    function setPending(int64 delta, uint64 sentBlock, uint64 sentAt, uint8 tries) external onlyOwner {
        pendingHedge = Pending({delta: delta, sentBlock: sentBlock, sentAt: sentAt, tries: tries});
    }

    function clearPending() external onlyOwner {
        pendingHedge = Pending({delta: 0, sentBlock: 0, sentAt: 0, tries: 0});
    }

    function _applyFill(int64 delta) internal {
        confirmedShort += delta;
        int64 magnitude = delta < 0 ? -delta : delta;
        uint256 units = uint256(uint64(magnitude)) * (10 ** (18 - szDecimals));
        if (delta < 0) {
            inventory = units > inventory ? 0 : inventory - units;
        } else {
            inventory += units;
        }
    }

    function _coreSize(uint256 assets) internal pure returns (int64) {
        uint256 units = assets / (10 ** (18 - szDecimals));
        if (units == 0) return 1;
        require(units <= uint256(uint64(type(int64).max)), "vault: size overflow");
        return int64(uint64(units));
    }
}
