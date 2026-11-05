// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoreWriterLib} from "@hyper-evm-lib/src/CoreWriterLib.sol";
import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";
import {ICoreDepositWallet} from "@hyper-evm-lib/src/interfaces/ICoreDepositWallet.sol";

/// @notice The vault's three doors into HyperCore: CoreWriter (writes), read precompiles (reads) and
///         Circle's CoreDepositWallet (USDC in).
/// Gotchas:
///  - sendRawAction never reverts on a bad order; always confirm with a read in a LATER block.
///  - precompiles show state as of block build; you can't see your own CoreWriter action in-tx.
///  - a precompile call with a bad asset id eats all gas given, so every read here is gas-capped.
///  - orders take the asset id (HIP-3: 100000 + dex*10000 + idx); reads take the perp index (dex*10000 + idx).
library HedgeLib {
    using SafeERC20 for IERC20;

    /// @dev Real precompiles cost ~2k + 65 gas/byte; the cap only bounds the damage of a bad read.
    uint256 internal constant PRECOMPILE_GAS = 100_000;

    uint32 internal constant HIP3_ASSET_OFFSET = 100_000;
    uint32 internal constant SPOT_DEX = type(uint32).max;
    uint64 internal constant USDC_TOKEN = 0;
    /// @dev Spot-send USDC here to bridge it from HyperCore back to the sender on HyperEVM.
    address internal constant USDC_SYSTEM_ADDRESS = 0x2000000000000000000000000000000000000000;

    error PrecompileFailed(address precompile);

    // ─── ids ──────────────────────────────────────────────────────────────

    /// @notice Order asset id → precompile perp index. Native perps use the same number for both.
    function perpIndexOf(uint32 asset) internal pure returns (uint32) {
        return asset >= HIP3_ASSET_OFFSET ? asset - HIP3_ASSET_OFFSET : asset;
    }

    /// @notice Deterministic client order id so keeper/dashboard can match fills in the info API.
    function makeCloid(bytes32 id, uint8 attempt) internal pure returns (uint128) {
        return uint128(uint256(keccak256(abi.encode(id, attempt))));
    }

    // ─── writes (CoreWriter) ──────────────────────────────────────────────

    /// @notice Action 1, IOC.
    /// @param px  wire price (human × 1e8), already rounded to tick
    /// @param sz  wire size  (human × 1e8), already rounded to szDecimals
    function limitOrderIoc(uint32 asset, bool isBuy, uint64 px, uint64 sz, bool reduceOnly, uint128 cloid) internal {
        CoreWriterLib.placeLimitOrder(asset, isBuy, px, sz, reduceOnly, HLConstants.LIMIT_ORDER_TIF_IOC, cloid);
    }

    /// @notice Action 13: move USDC between the vault's own spot balance and a perp DEX (e.g. spot → xyz).
    /// @dev VERIFY (open question 2): the exact route that funds the xyz DEX's isolated margin.
    function sendAsset(address dest, uint32 srcDex, uint32 dstDex, uint64 token, uint64 amountWei) internal {
        CoreWriterLib.sendAsset(dest, address(0), srcDex, dstDex, token, amountWei);
    }

    /// @notice Action 6. To the USDC system address this bridges Core spot USDC back to the vault on HyperEVM.
    function spotSend(address dest, uint64 token, uint64 amountWei) internal {
        CoreWriterLib.spotSend(dest, token, amountWei);
    }

    /// @notice Action 9: authorise an agent wallet to sign L1 actions (not withdrawals) for the vault's account.
    function addApiWallet(address wallet, string memory name) internal {
        CoreWriterLib.addApiWallet(wallet, name);
    }

    // ─── money in (CoreDepositWallet) ─────────────────────────────────────

    /// @notice HyperEVM → HyperCore. `destinationDex`: 0 = default perps, type(uint32).max = spot, else a perp DEX.
    /// @dev Credit appears on Core from the next block. A brand-new account pays a 1 USDC activation fee.
    function depositUsdc(IERC20 usdc, address wallet, uint256 amount, uint32 destinationDex) internal {
        usdc.forceApprove(wallet, amount);
        ICoreDepositWallet(wallet).deposit(amount, destinationDex);
    }

    // ─── reads (precompiles) ──────────────────────────────────────────────

    function position(address user, uint32 perpIndex) internal view returns (PrecompileLib.Position memory) {
        bytes memory ret = _read(HLConstants.POSITION2_PRECOMPILE_ADDRESS, abi.encode(user, perpIndex), 160);
        return abi.decode(ret, (PrecompileLib.Position));
    }

    function oraclePx(uint32 perpIndex) internal view returns (uint64 px) {
        px = abi.decode(_read(HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS, abi.encode(perpIndex), 32), (uint64));
        if (px == 0) revert PrecompileFailed(HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS); // unknown asset reads as 0
    }

    function marginSummary(uint32 dexIndex, address user)
        internal
        view
        returns (PrecompileLib.AccountMarginSummary memory)
    {
        bytes memory ret = _read(HLConstants.ACCOUNT_MARGIN_SUMMARY_PRECOMPILE_ADDRESS, abi.encode(dexIndex, user), 128);
        return abi.decode(ret, (PrecompileLib.AccountMarginSummary));
    }

    function spotBalance(address user, uint64 token) internal view returns (PrecompileLib.SpotBalance memory) {
        bytes memory ret = _read(HLConstants.SPOT_BALANCE_PRECOMPILE_ADDRESS, abi.encode(user, token), 96);
        return abi.decode(ret, (PrecompileLib.SpotBalance));
    }

    function coreUserExists(address user) internal view returns (bool) {
        return abi.decode(_read(HLConstants.CORE_USER_EXISTS_PRECOMPILE_ADDRESS, abi.encode(user), 32), (bool));
    }

    /// @dev Calldata is the raw ABI-encoded arguments, no selector. A missing precompile (no code) returns
    ///      empty data, which the length check turns into a clean revert instead of a decode panic.
    function _read(address precompile, bytes memory args, uint256 minLen) private view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = precompile.staticcall{gas: PRECOMPILE_GAS}(args);
        if (!ok || ret.length < minLen) revert PrecompileFailed(precompile);
    }
}
