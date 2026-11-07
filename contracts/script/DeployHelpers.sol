// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {RiskParams} from "../src/RiskParams.sol";

library DeployHelpers {
    int24 internal constant TICK_SPACING = 60;
    /// @dev Market A's separate "weekend" pool for the NaiveLiquidator, so the vault's pool can stay on the oracle.
    uint24 internal constant THIN_POOL_FEE = 500;
    int24 internal constant THIN_TICK_SPACING = 10;

    /// @notice Hackathon defaults for xyz:NVDA (szDecimals 3, ~$217, max 20x). Tune after the pre-kickoff
    ///         spikes (orderDelaySec and transitBlocks especially).
    function defaultRisk() internal pure returns (RiskParams.Params memory) {
        return RiskParams.Params({
            maxLiquidation: 50_000e6,
            maxUnhedged: 2000, // Core size units; at szDecimals=3 → 2 NVDA (~$430), also the unwind chunk
            leverage: 3,
            marginBufferBps: 2000,
            minDiscountBps: 300,
            oracleBandBps: 150,
            hedgeCapBps: 100,
            maxSlippageBps: 100, // pool fee 30 + impact ≤ 50 + basis
            maxTries: 3,
            orderDelaySec: 5,
            cooldownOpenSec: 10,
            cooldownClosedSec: 300,
            withdrawReserve: 500e6,
            maxImpactBps: 50,
            transitBlocks: 1
        });
    }

    /// @notice The Chainlink forwarder that delivers CRE reports to RiskParams (docs.chain.link/cre, forwarder
    ///         directory). HyperEVM testnet gets the simulation forwarder, which `cre workflow simulate --broadcast`
    ///         writes through. Chains without one (anvil) use `fallback_`, which can then post reports itself.
    function creForwarder(address fallback_) internal view returns (address) {
        if (block.chainid == 999) return 0x9eF6468C5f37b976E57d52054c693269479A784d; // KeystoneForwarder
        if (block.chainid == 998) return 0xB27fA1c28288c50542527F64BCda22C9FbAc24CB; // MockKeystoneForwarder
        return fallback_;
    }

    /// @notice The vault's NVDAx/USDC pool every script agrees on: Seiz3Hook with a dynamic fee (the hook sets
    ///         it per swap: 0.3% while the market is open, wider after the bell).
    function poolKey(address usdc, address nvdax, address hook) internal pure returns (PoolKey memory) {
        (address c0, address c1) = usdc < nvdax ? (usdc, nvdax) : (nvdax, usdc);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(hook));
    }

    /// @notice Market A's own "weekend" pool: same tokens, 0.05% static fee, no hook. Keeps the naive dump out of
    ///         the vault's pool, so the hook's pool stays on the oracle.
    function thinPoolKey(address usdc, address nvdax) internal pure returns (PoolKey memory) {
        (address c0, address c1) = usdc < nvdax ? (usdc, nvdax) : (nvdax, usdc);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), THIN_POOL_FEE, THIN_TICK_SPACING, IHooks(address(0)));
    }

    function deploymentPath(string memory projectRoot, string memory network) internal pure returns (string memory) {
        return string.concat(projectRoot, "/../deployments/", network, ".json");
    }

    /// @notice Find a CREATE2 salt whose address carries exactly `flags` in its low 14 bits (v4 reads a hook's
    ///         permissions from its address). Hashes in scratch memory, so the ~16k tries stay far under the 30M
    ///         gas a script call gets (v4-periphery's test HookMiner re-hashes the init code on every try).
    /// @param deployer `CREATE2_FACTORY` in a broadcast script, the deploying contract otherwise
    function mineHookSalt(address deployer, uint160 flags, bytes32 initCodeHash)
        internal
        view
        returns (address hook, bytes32 salt)
    {
        for (uint256 s; s < 1_000_000; ++s) {
            assembly ("memory-safe") {
                let p := mload(0x40)
                mstore(p, or(shl(160, 0xff), deployer)) // 0xff ++ deployer in bytes 11..31
                mstore(add(p, 32), s)
                mstore(add(p, 64), initCodeHash)
                hook := and(keccak256(add(p, 11), 85), 0xffffffffffffffffffffffffffffffffffffffff)
            }
            if (uint160(hook) & Hooks.ALL_HOOK_MASK == flags && hook.code.length == 0) return (hook, bytes32(s));
        }
        revert("no hook salt found");
    }
}
