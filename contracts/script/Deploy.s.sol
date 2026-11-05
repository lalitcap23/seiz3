// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {RiskParams} from "../src/RiskParams.sol";
import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice Deploys MockNVDAx, RiskParams and the vault, then writes deployments/<NETWORK>.json.
/// Flip the deployer into big-block mode first (see README) — the vault exceeds the 3M small-block cap.
///
///   NETWORK=testnet forge script script/Deploy.s.sol --rpc-url hyperevm_testnet --broadcast
contract Deploy is Script {
    uint24 constant POOL_FEE = 3000;
    int24 constant TICK_SPACING = 60;

    function run() external {
        string memory network = vm.envOr("NETWORK", string("testnet"));
        address usdc = vm.envAddress("USDC_ADDRESS");
        address morpho = vm.envAddress("MORPHO_ADDRESS");
        address poolManager = vm.envAddress("POOL_MANAGER_ADDRESS");
        uint32 perpAsset = uint32(vm.envUint("PERP_ASSET"));
        uint32 perpDexIndex = uint32(vm.envUint("PERP_DEX_INDEX"));
        uint8 szDecimals = uint8(vm.envUint("SZ_DECIMALS"));

        vm.startBroadcast();
        address deployer = msg.sender;

        MockNVDAx nvdax = new MockNVDAx(deployer);
        RiskParams risk = new RiskParams(deployer, DeployHelpers.defaultRisk());

        PoolKey memory key = _poolKey(usdc, address(nvdax));
        AfterbellVault vault = new AfterbellVault(
            deployer,
            AfterbellVault.Wiring({
                usdc: IERC20(usdc),
                nvdax: IERC20(address(nvdax)),
                morpho: IMorpho(morpho),
                poolManager: IPoolManager(poolManager),
                poolKey: key,
                risk: risk,
                perpAsset: perpAsset,
                perpDexIndex: perpDexIndex,
                szDecimals: szDecimals
            })
        );

        // TODO: seed deposit (inflation guard) + few USDC to Core for account activation
        vm.stopBroadcast();

        _write(network, vault);
    }

    function _poolKey(address a, address b) internal pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), POOL_FEE, TICK_SPACING, IHooks(address(0)));
    }

    function _write(string memory network, AfterbellVault vault) internal {
        (Currency c0, Currency c1, uint24 fee, int24 tickSpacing, IHooks hooks) = vault.poolKey();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(vault.usdc()));
        vm.serializeAddress(o, "morpho", address(vault.morpho()));
        vm.serializeAddress(o, "poolManager", address(vault.poolManager()));
        vm.serializeAddress(o, "nvdax", address(vault.nvdax()));
        vm.serializeAddress(o, "riskParams", address(vault.risk()));
        vm.serializeAddress(o, "vault", address(vault));

        string memory k = "poolKey";
        vm.serializeAddress(k, "currency0", Currency.unwrap(c0));
        vm.serializeAddress(k, "currency1", Currency.unwrap(c1));
        vm.serializeUint(k, "fee", fee);
        vm.serializeInt(k, "tickSpacing", tickSpacing);
        string memory keyJson = vm.serializeAddress(k, "hooks", address(hooks));
        vm.serializeString(o, "poolKey", keyJson);

        string memory h = "hypercore";
        vm.serializeUint(h, "perpAsset", vault.perpAsset());
        vm.serializeUint(h, "perpDexIndex", vault.perpDexIndex());
        string memory hJson = vm.serializeUint(h, "szDecimals", vault.szDecimals());
        string memory json = vm.serializeString(o, "hypercore", hJson);

        string memory path = string.concat(vm.projectRoot(), "/../deployments/", network, ".json");
        vm.writeJson(json, path);
        console.log("wrote", path);
    }
}
