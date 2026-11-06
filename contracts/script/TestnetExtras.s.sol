// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {Faucet} from "../src/mocks/Faucet.sol";
import {NaiveLiquidator} from "../src/mocks/NaiveLiquidator.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice What public testers need on top of the step-3 deploy, without redeploying the vault:
///         - Faucet: NVDAx, USDC and HYPE drips (the owner funds it; the API's operator key drips for testers);
///         - PoolSwapTest as the public swap router (PoolSeeder is owner-only);
///         - a NaiveLiquidator on its own thin 0.05% pool, so the vault's 0.3% pool can be the deep one.
///         Merges faucet / swapRouter / thinPoolKey / naiveLiquidator into deployments/<NETWORK>.json.
///         Then SeedPool.s.sol with THIN=true seeds the thin pool (it reads thinPoolKey), THIN=false the deep one.
///
///   FAUCET_OPERATOR=0x… NETWORK=testnet forge script script/TestnetExtras.s.sol --rpc-url hyperevm_testnet --broadcast
contract TestnetExtras is Script {
    function run() external {
        string memory network = vm.envOr("NETWORK", string("testnet"));
        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), network);
        string memory dep = vm.readFile(path);
        IERC20 usdc = IERC20(vm.parseJsonAddress(dep, ".usdc"));
        IERC20 nvdax = IERC20(vm.parseJsonAddress(dep, ".nvdax"));
        IMorpho morpho = IMorpho(vm.parseJsonAddress(dep, ".morpho"));
        IPoolManager pm = IPoolManager(vm.parseJsonAddress(dep, ".poolManager"));
        PoolKey memory thin = DeployHelpers.thinPoolKey(address(usdc), address(nvdax));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Faucet faucet = new Faucet(
            deployer,
            nvdax,
            usdc,
            vm.envOr("FAUCET_NVDAX", uint256(0.1e18)), // ~$21: one liquidation's hedge clears the $10 order minimum
            vm.envOr("FAUCET_USDC", uint256(10e6)),
            vm.envOr("FAUCET_HYPE", uint256(0.002 ether)), // ~100 txs at 0.1 gwei
            uint64(vm.envOr("FAUCET_COOLDOWN", uint256(1 days)))
        );
        address operator = vm.envOr("FAUCET_OPERATOR", address(0));
        if (operator != address(0)) faucet.setOperator(operator, true);
        PoolSwapTest router = new PoolSwapTest(pm);
        NaiveLiquidator naive = new NaiveLiquidator(deployer, morpho, pm, thin, nvdax);
        vm.stopBroadcast();

        vm.serializeJson("deployment", dep);
        vm.serializeAddress("deployment", "faucet", address(faucet));
        vm.serializeAddress("deployment", "swapRouter", address(router));
        vm.serializeString("deployment", "thinPoolKey", _keyJson(thin));
        string memory json = vm.serializeAddress("deployment", "naiveLiquidator", address(naive));
        vm.writeJson(json, path);
        console.log("faucet", address(faucet));
        console.log("swapRouter", address(router));
        console.log("naiveLiquidator (thin pool)", address(naive));
    }

    function _keyJson(PoolKey memory key) internal returns (string memory) {
        string memory k = "thinPoolKey";
        vm.serializeAddress(k, "currency0", Currency.unwrap(key.currency0));
        vm.serializeAddress(k, "currency1", Currency.unwrap(key.currency1));
        vm.serializeUint(k, "fee", key.fee);
        vm.serializeInt(k, "tickSpacing", key.tickSpacing);
        return vm.serializeAddress(k, "hooks", address(key.hooks));
    }
}
