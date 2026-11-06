// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";

/// @notice Scriptable stand-in for HyperCore in offline tests: CoreWriter, the read precompiles and Circle's
///         CoreDepositWallet, for one perp (the vault's xyz:NVDA).
/// @dev Unlike hyper-evm-lib's simulator it can partially fill or drop orders and it rejects orders that are off
///      Hyperliquid's price/size grid, so a rounding bug shows up as a dropped order. Like the real thing, nothing
///      happens until the block ends: tests call `processBlock()` after advancing a block (deposits first, then
///      CoreWriter actions in order). Failed actions are dropped silently.
contract MockHyperCore {
    struct Order {
        address sender;
        uint32 asset;
        bool isBuy;
        uint64 limitPx;
        uint64 sz;
        bool reduceOnly;
        uint8 tif;
        uint128 cloid;
        uint64 filled; // Core size units
    }

    struct Action {
        address sender;
        uint24 kind;
        bytes data;
    }

    struct Deposit {
        address user;
        uint256 amount;
        uint32 dex;
    }

    address public constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    uint32 public constant SPOT_DEX = type(uint32).max;
    uint256 public constant ACTIVATION_FEE = 1e6;

    IERC20 public immutable usdc;
    uint32 public immutable perpIndex;
    uint32 public immutable dex;
    uint8 public immutable szDecimals;
    MockCoreDepositWallet public depositWallet;

    // knobs
    uint16 public fillBps = 10_000;
    uint256 public dropNext; // drop the next N orders outright
    uint16 public feeBps; // taker fee, bps of fill notional
    uint32 public leverage = 3;
    bool public failReads; // every precompile read burns all its gas, like a bad asset id

    // market (raw perp px: 6 − szDecimals decimals)
    uint64 public oraclePx;
    uint64 public markPx;

    // accounts
    mapping(address => bool) public exists;
    mapping(address => uint64) public spotWei; // USDC, 8 dec
    mapping(address => mapping(uint32 => uint64)) public dexBalance; // realised USD, 6 dec
    mapping(address => int64) public szi;
    mapping(address => uint64) public entryNtl; // USD, 6 dec

    Action[] internal _actions;
    Deposit[] internal _deposits;
    Order[] internal _orders;
    address[] public apiWallets;

    constructor(IERC20 usdc_, uint32 perpIndex_, uint32 dex_, uint8 szDecimals_) {
        usdc = usdc_;
        perpIndex = perpIndex_;
        dex = dex_;
        szDecimals = szDecimals_;
    }

    /// @notice Deploy the stubs and etch them over CoreWriter and the read precompiles.
    function install(Vm vm) external returns (MockCoreDepositWallet) {
        (address stub, address writer) = deployStubs();
        for (uint160 i; i <= 0x13; ++i) {
            vm.etch(address(uint160(0x800) + i), stub.code);
        }
        vm.etch(CORE_WRITER, writer.code);
        return depositWallet;
    }

    /// @notice `install` without cheatcodes, for a live anvil: the caller copies the stubs' code over the
    ///         precompiles (0x…0800–0x…0813) and CoreWriter with `anvil_setCode` (scripts/local-stack.sh).
    function deployStubs() public returns (address precompileStub, address coreWriterStub) {
        precompileStub = address(new PrecompileStub(this));
        coreWriterStub = address(new CoreWriterStub(this));
        depositWallet = new MockCoreDepositWallet(this, usdc);
    }

    // ─── knobs ────────────────────────────────────────────────────────────

    function setPx(uint64 px) external {
        oraclePx = px;
        markPx = px;
    }

    function setMarkPx(uint64 px) external {
        markPx = px;
    }

    function setFillBps(uint16 bps) external {
        fillBps = bps;
    }

    function setDropNext(uint256 n) external {
        dropNext = n;
    }

    function setFeeBps(uint16 bps) external {
        feeBps = bps;
    }

    function setFailReads(bool fail) external {
        failReads = fail;
    }

    function forceActivate(address user) external {
        exists[user] = true;
    }

    function forceDexBalance(address user, uint64 usd) external {
        dexBalance[user][dex] = usd;
    }

    /// @notice Overwrite a position, e.g. to model a Core liquidation or a late double fill.
    function forcePosition(address user, int64 size, uint64 ntl) external {
        szi[user] = size;
        entryNtl[user] = ntl;
    }

    // ─── entry points from the stubs ──────────────────────────────────────

    function enqueue(address sender, bytes calldata raw) external {
        require(msg.sender == CORE_WRITER, "only CoreWriter");
        require(uint8(raw[0]) == 1, "version");
        uint24 kind = uint24(bytes3(raw[1:4]));
        _actions.push(Action(sender, kind, raw[4:]));
    }

    function queueDeposit(address user, uint256 amount, uint32 destinationDex) external {
        require(msg.sender == address(depositWallet), "only deposit wallet");
        _deposits.push(Deposit(user, amount, destinationDex));
    }

    // ─── block processing ─────────────────────────────────────────────────

    function processBlock() external {
        for (uint256 i; i < _deposits.length; ++i) {
            _credit(_deposits[i]);
        }
        delete _deposits;

        Action[] memory actions = _actions;
        delete _actions;
        for (uint256 i; i < actions.length; ++i) {
            try this.execute(actions[i]) {} catch {}
        }
    }

    function execute(Action calldata a) external {
        require(msg.sender == address(this), "self only");
        require(exists[a.sender], "no account");
        if (a.kind == HLConstants.LIMIT_ORDER_ACTION) _limitOrder(a.sender, a.data);
        else if (a.kind == HLConstants.SEND_ASSET_ACTION) _sendAsset(a.sender, a.data);
        else if (a.kind == HLConstants.SPOT_SEND_ACTION) _spotSend(a.sender, a.data);
        else if (a.kind == HLConstants.ADD_API_WALLET_ACTION) _addApiWallet(a.data);
        else revert("unsupported action");
    }

    function _credit(Deposit memory d) internal {
        uint256 amount = d.amount;
        if (!exists[d.user]) {
            if (amount < ACTIVATION_FEE) return;
            exists[d.user] = true;
            amount -= ACTIVATION_FEE;
        }
        if (d.dex == SPOT_DEX) spotWei[d.user] += uint64(amount * 100);
        else dexBalance[d.user][d.dex] += uint64(amount);
    }

    function _limitOrder(address sender, bytes calldata data) internal {
        Order memory o;
        o.sender = sender;
        (o.asset, o.isBuy, o.limitPx, o.sz, o.reduceOnly, o.tif, o.cloid) =
            abi.decode(data, (uint32, bool, uint64, uint64, bool, uint8, uint128));
        o.filled = _fillable(o);
        if (o.filled > 0) _apply(sender, o.isBuy, o.filled);
        _orders.push(o);
    }

    /// @dev What an IOC order would fill right now, 0 if Hyperliquid would reject or cancel it.
    function _fillable(Order memory o) internal returns (uint64 fill) {
        if (dropNext > 0) {
            --dropNext;
            return 0;
        }
        if (o.asset != 100_000 + perpIndex || o.tif != HLConstants.LIMIT_ORDER_TIF_IOC) return 0;
        uint64 step = uint64(10 ** (8 - szDecimals));
        if (o.sz == 0 || o.sz % step != 0 || !validWirePx(o.limitPx)) return 0; // off grid → rejected
        uint64 markWire = markPx * uint64(10 ** (2 + szDecimals));
        if (o.isBuy ? markWire > o.limitPx : markWire < o.limitPx) return 0; // doesn't cross → cancelled

        fill = uint64(uint256(o.sz / step) * fillBps / 10_000);
        int64 s = szi[o.sender];
        if (o.reduceOnly) {
            if (o.isBuy ? s >= 0 : s <= 0) return 0;
            uint64 open = _abs(s);
            if (fill > open) fill = open;
        } else {
            int64 next = o.isBuy ? s + int64(fill) : s - int64(fill);
            bool grows = _abs(next) > _abs(s);
            if (grows && uint256(_abs(next)) * markPx / leverage > accountValue(o.sender)) return 0; // no margin
        }
    }

    function _apply(address u, bool isBuy, uint64 fill) internal {
        uint64 px = markPx;
        if (feeBps > 0) _addBalance(u, -int256(uint256(fill) * px * feeBps / 10_000));
        int64 s = szi[u];
        bool reducing = isBuy ? s < 0 : s > 0;
        if (reducing) {
            uint64 open = _abs(s);
            uint64 closing = fill > open ? open : fill;
            uint64 avg = entryNtl[u] / open;
            int256 perUnit =
                isBuy ? int256(uint256(avg)) - int256(uint256(px)) : int256(uint256(px)) - int256(uint256(avg));
            _addBalance(u, int256(uint256(closing)) * perUnit);
            s = isBuy ? s + int64(closing) : s - int64(closing);
            entryNtl[u] = s == 0 ? 0 : entryNtl[u] - closing * avg;
            fill -= closing;
        }
        if (fill > 0) {
            s = isBuy ? s + int64(fill) : s - int64(fill);
            entryNtl[u] += fill * px;
        }
        szi[u] = s;
    }

    function _sendAsset(address sender, bytes calldata data) internal {
        (address dest,, uint32 src, uint32 dst, uint64 token, uint64 amountWei) =
            abi.decode(data, (address, address, uint32, uint32, uint64, uint64));
        require(token == 0 && amountWei % 100 == 0, "usdc, whole perp units");
        uint64 perp = amountWei / 100;
        if (src == SPOT_DEX && dst == dex) {
            spotWei[sender] -= amountWei; // reverts when short → dropped
            dexBalance[dest][dex] += perp;
        } else if (src == dex && dst == SPOT_DEX) {
            uint256 locked = uint256(_abs(szi[sender])) * markPx / leverage;
            require(accountValue(sender) >= perp + locked, "margin locked");
            dexBalance[sender][dex] -= perp;
            spotWei[dest] += amountWei;
        } else {
            revert("route");
        }
    }

    function _spotSend(address sender, bytes calldata data) internal {
        (address dest, uint64 token, uint64 amountWei) = abi.decode(data, (address, uint64, uint64));
        require(token == 0, "usdc only");
        spotWei[sender] -= amountWei;
        if (dest == address(HLConstants.BASE_SYSTEM_ADDRESS)) depositWallet.payOut(sender, amountWei / 100); // USDC system address
        else spotWei[dest] += amountWei;
    }

    function _addApiWallet(bytes calldata data) internal {
        (address wallet,) = abi.decode(data, (address, string));
        apiWallets.push(wallet);
    }

    function _addBalance(address u, int256 delta) internal {
        int256 next = int256(uint256(dexBalance[u][dex])) + delta;
        dexBalance[u][dex] = next > 0 ? uint64(uint256(next)) : 0;
    }

    // ─── reads ────────────────────────────────────────────────────────────

    function accountValue(address u) public view returns (uint256) {
        int256 v = int256(uint256(dexBalance[u][dex])) + uPnl(u);
        return v > 0 ? uint256(v) : 0;
    }

    function uPnl(address u) public view returns (int256) {
        int64 s = szi[u];
        if (s == 0) return 0;
        int256 ntl = int256(uint256(_abs(s)) * markPx);
        return s > 0 ? ntl - int256(uint256(entryNtl[u])) : int256(uint256(entryNtl[u])) - ntl;
    }

    /// @notice Precompile dispatch; `precompile` is the address the stub was etched at.
    function read(address precompile, bytes calldata data) external view returns (bytes memory) {
        if (failReads) {
            while (true) {} // a bad asset id eats all the gas it's given
        }
        if (
            precompile == HLConstants.POSITION2_PRECOMPILE_ADDRESS
                || precompile == HLConstants.POSITION_PRECOMPILE_ADDRESS
        ) {
            (address user, uint32 idx) = abi.decode(data, (address, uint32));
            require(idx == perpIndex, "bad perp");
            return abi.encode(
                PrecompileLib.Position({
                    szi: szi[user], entryNtl: entryNtl[user], isolatedRawUsd: 0, leverage: leverage, isIsolated: true
                })
            );
        }
        if (precompile == HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS) {
            require(abi.decode(data, (uint32)) == perpIndex, "bad perp");
            return abi.encode(oraclePx);
        }
        if (precompile == HLConstants.MARK_PX_PRECOMPILE_ADDRESS) {
            require(abi.decode(data, (uint32)) == perpIndex, "bad perp");
            return abi.encode(markPx);
        }
        if (precompile == HLConstants.ACCOUNT_MARGIN_SUMMARY_PRECOMPILE_ADDRESS) {
            (uint32 d, address user) = abi.decode(data, (uint32, address));
            if (d != dex) return abi.encode(PrecompileLib.AccountMarginSummary(0, 0, 0, 0));
            uint64 ntl = _abs(szi[user]) * markPx;
            int64 value = int64(uint64(accountValue(user)));
            return abi.encode(
                PrecompileLib.AccountMarginSummary({
                    accountValue: value,
                    marginUsed: ntl / leverage,
                    ntlPos: ntl,
                    rawUsd: szi[user] < 0 ? value + int64(ntl) : value - int64(ntl)
                })
            );
        }
        if (precompile == HLConstants.SPOT_BALANCE_PRECOMPILE_ADDRESS) {
            (address user, uint64 token) = abi.decode(data, (address, uint64));
            return abi.encode(PrecompileLib.SpotBalance({total: token == 0 ? spotWei[user] : 0, hold: 0, entryNtl: 0}));
        }
        if (precompile == HLConstants.CORE_USER_EXISTS_PRECOMPILE_ADDRESS) {
            return abi.encode(exists[abi.decode(data, (address))]);
        }
        if (precompile == HLConstants.PERP_ASSET_INFO_PRECOMPILE_ADDRESS) {
            require(abi.decode(data, (uint32)) == perpIndex, "bad perp");
            return abi.encode(
                PrecompileLib.PerpAssetInfo({
                    coin: "xyz:NVDA", marginTableId: 20, szDecimals: szDecimals, maxLeverage: 20, onlyIsolated: true
                })
            );
        }
        revert("unsupported precompile");
    }

    /// @notice True if a wire price (human × 1e8) is on Hyperliquid's grid for this asset.
    function validWirePx(uint64 wire) public view returns (bool) {
        uint256 unit = 10 ** (2 + szDecimals); // at most (6 − szDecimals) decimals
        if (wire == 0 || wire % unit != 0) return false;
        uint256 raw = wire / unit;
        if (raw % 10 ** (6 - szDecimals) == 0) return true; // integer prices are always valid
        while (raw % 10 == 0) raw /= 10;
        uint256 digits;
        for (uint256 v = raw; v != 0; v /= 10) {
            ++digits;
        }
        return digits <= 5;
    }

    // ─── test views ───────────────────────────────────────────────────────

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function order(uint256 i) external view returns (Order memory) {
        return _orders[i];
    }

    function lastOrder() external view returns (Order memory) {
        return _orders[_orders.length - 1];
    }

    function queuedActions() external view returns (uint256) {
        return _actions.length;
    }

    function apiWalletCount() external view returns (uint256) {
        return apiWallets.length;
    }

    function _abs(int64 x) internal pure returns (uint64) {
        return x >= 0 ? uint64(x) : uint64(-x);
    }
}

/// @dev Etched at every read precompile address; `core` is an immutable, so it survives `vm.etch`.
contract PrecompileStub {
    MockHyperCore internal immutable core;

    constructor(MockHyperCore core_) {
        core = core_;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        return core.read(address(this), data);
    }
}

/// @dev Etched at 0x3333…3333.
contract CoreWriterStub {
    MockHyperCore internal immutable core;

    event RawAction(address indexed user, bytes data);

    constructor(MockHyperCore core_) {
        core = core_;
    }

    function sendRawAction(bytes calldata data) external {
        core.enqueue(msg.sender, data);
        emit RawAction(msg.sender, data);
    }
}

/// @dev Holds deposited USDC so Core → EVM spot sends can pay it back out.
contract MockCoreDepositWallet {
    MockHyperCore public immutable core;
    IERC20 public immutable usdc;

    constructor(MockHyperCore core_, IERC20 usdc_) {
        core = core_;
        usdc = usdc_;
    }

    function deposit(uint256 amount, uint32 destinationDex) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        core.queueDeposit(msg.sender, amount, destinationDex);
    }

    function payOut(address to, uint256 amount) external {
        require(msg.sender == address(core), "only core");
        usdc.transfer(to, amount);
    }
}
