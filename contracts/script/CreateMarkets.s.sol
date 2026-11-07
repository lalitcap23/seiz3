// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IMorpho, MarketParams, Id} from "@morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "@morpho-blue/libraries/MarketParamsLib.sol";
import {Seiz3Vault} from "../src/Seiz3Vault.sol";
import {DemoOracle} from "../src/mocks/DemoOracle.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice Creates the three demo Morpho markets (A naive, B conservative, C Seiz3), allow-lists C on the
///         vault and merges `markets` into deployments/<NETWORK>.json. Run after Deploy.s.sol.
/// Each market gets its OWN DemoOracle, otherwise A and C (same tokens + LLTV) collapse into one market id.
/// VERIFY (spike 5): enabled LLTVs + IRM on Morpho's HyperEVM deployment.
///
///   NETWORK=testnet MORPHO_IRM_ADDRESS=0x… forge script script/CreateMarkets.s.sol --rpc-url hyperevm_testnet --broadcast
contract CreateMarkets is Script {
    using MarketParamsLib for MarketParams;

    uint256 constant LLTV_HIGH = 0.77 ether;
    uint256 constant LLTV_LOW = 0.385 ether;
    /// @dev Morpho price = USDC per NVDAx × 10^(36 + 6 − 18) = usd6 × 1e18
    uint256 constant MORPHO_SCALE = 1e18;

    function run() external {
        string memory network = vm.envOr("NETWORK", string("testnet"));
        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), network);
        string memory dep = vm.readFile(path);

        (Id[3] memory ids, address[3] memory oracles) = _create(dep);
        _write(path, dep, ids, oracles);
    }

    function _create(string memory dep) internal returns (Id[3] memory ids, address[3] memory oracles) {
        IMorpho morpho = IMorpho(vm.parseJsonAddress(dep, ".morpho"));
        address usdc = vm.parseJsonAddress(dep, ".usdc");
        address nvdax = vm.parseJsonAddress(dep, ".nvdax");
        Seiz3Vault vault = Seiz3Vault(vm.parseJsonAddress(dep, ".vault"));
        address irm = vm.envAddress("MORPHO_IRM_ADDRESS");
        uint256 startPrice = vm.envOr("START_PRICE_USD6", uint256(217e6)) * MORPHO_SCALE;

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers(); // the broadcasting account, however run() was invoked
        for (uint256 i; i < 3; ++i) {
            DemoOracle oracle = new DemoOracle(deployer, startPrice);
            MarketParams memory mp = MarketParams(usdc, nvdax, address(oracle), irm, _lltv(i));
            morpho.createMarket(mp);
            ids[i] = mp.id();
            oracles[i] = address(oracle);
            if (i == 2) vault.setMarketAllowed(mp, true);
        }
        vm.stopBroadcast();
    }

    function _write(string memory path, string memory dep, Id[3] memory ids, address[3] memory oracles) internal {
        string[3] memory names = ["A_naive", "B_conservative", "C_seiz3"];
        string memory marketsJson;
        for (uint256 i; i < 3; ++i) {
            vm.serializeBytes32(names[i], "id", Id.unwrap(ids[i]));
            vm.serializeAddress(names[i], "oracle", oracles[i]);
            string memory m = vm.serializeString(names[i], "lltv", vm.toString(_lltv(i)));
            marketsJson = vm.serializeString("markets", names[i], m);
            console.log(names[i], oracles[i]);
        }
        vm.serializeJson("deployment", dep);
        vm.writeJson(vm.serializeString("deployment", "markets", marketsJson), path);
        console.log("merged markets into", path);
    }

    /// @dev A and C share LLTV (they differ only by oracle address); B is the conservative market.
    function _lltv(uint256 i) internal pure returns (uint256) {
        return i == 1 ? LLTV_LOW : LLTV_HIGH;
    }
}
