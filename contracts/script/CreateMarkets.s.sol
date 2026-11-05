// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IMorpho, MarketParams, Id} from "@morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "@morpho-blue/libraries/MarketParamsLib.sol";
import {DemoOracle} from "../src/mocks/DemoOracle.sol";

/// @notice Creates the three demo Morpho markets (A naive, B conservative, C Afterbell).
/// Each market gets its OWN DemoOracle, otherwise A and C (same tokens + LLTV) collapse into one market id.
/// VERIFY (spike 5): enabled LLTVs + IRM on Morpho's HyperEVM deployment.
contract CreateMarkets is Script {
    using MarketParamsLib for MarketParams;

    uint256 constant LLTV_HIGH = 0.77 ether;
    uint256 constant LLTV_LOW = 0.385 ether;
    uint256 constant START_PRICE = 180e6 * 1e18; // $180, Morpho 1e36 scaling for 6/18 dec

    function run() external {
        IMorpho morpho = IMorpho(vm.envAddress("MORPHO_ADDRESS"));
        address usdc = vm.envAddress("USDC_ADDRESS");
        address nvdax = vm.envAddress("NVDAX_ADDRESS");
        address irm = vm.envAddress("MORPHO_IRM_ADDRESS");

        vm.startBroadcast();
        address deployer = msg.sender;
        uint256[3] memory lltvs = [LLTV_HIGH, LLTV_LOW, LLTV_HIGH];
        string[3] memory names = ["A_naive", "B_conservative", "C_afterbell"];

        for (uint256 i; i < 3; ++i) {
            DemoOracle oracle = new DemoOracle(deployer, START_PRICE);
            MarketParams memory mp = MarketParams(usdc, nvdax, address(oracle), irm, lltvs[i]);
            morpho.createMarket(mp);
            console.log(names[i]);
            console.log("  oracle", address(oracle));
            console.logBytes32(Id.unwrap(mp.id()));
        }
        vm.stopBroadcast();
        // TODO: merge market ids + oracles into deployments/<network>.json
    }
}
