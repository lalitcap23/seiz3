// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "@morpho-blue/interfaces/IMorpho.sol";

import {Seiz3Vault} from "../src/Seiz3Vault.sol";
import {RiskParams} from "../src/RiskParams.sol";
import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {DemoOracle} from "../src/mocks/DemoOracle.sol";
import {Units} from "../src/libs/Units.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice Testnet counterpart of LocalActors.s.sol, after TestnetInfra → Deploy → CreateMarkets: risk params sized
///         for a 1 NVDAx demo, LP money in the vault, a lender in market C, and a borrower (the deployer) just under
///         the 77% LLTV at HyperCore's live NVDA price. `scripts/testnet-stack.sh crash` then moves market C's oracle
///         ~1.4% down: liquidatable, yet inside the vault's 1.5% band around HyperCore's oracle, which we can't move.
/// Runs before the vault's first Core deposit: after it (`coreFunded`), deposits read the HyperCore precompiles,
/// which forge's local EVM doesn't have.
///
///   PRICE_USD6=212290000 NETWORK=testnet forge script script/TestnetActors.s.sol --rpc-url hyperevm_testnet --broadcast
contract TestnetActors is Script {
    uint256 constant LP_DEPOSIT = 200e6;
    uint256 constant LENDER_SUPPLY = 180e6;
    uint256 constant COLLATERAL = 1e18;
    uint256 constant LTV_BPS = 7680; // under the 77% LLTV at PRICE_USD6, over it after a ~0.3% drop
    uint256 constant MORPHO_SCALE = 1e18; // DemoOracle price = usd6 × 1e18 (CreateMarkets)

    function run() external {
        string memory network = vm.envOr("NETWORK", string("testnet"));
        string memory dep = vm.readFile(DeployHelpers.deploymentPath(vm.projectRoot(), network));
        Seiz3Vault vault = Seiz3Vault(vm.parseJsonAddress(dep, ".vault"));
        IMorpho morpho = vault.morpho();
        IERC20 usdc = vault.usdc();
        MockNVDAx nvdax = MockNVDAx(address(vault.nvdax()));
        MarketParams memory market =
            morpho.idToMarketParams(Id.wrap(vm.parseJsonBytes32(dep, ".markets.C_seiz3.id")));
        uint256 px = vm.envUint("PRICE_USD6"); // HyperCore's live NVDA oracle, USDC 6 dec
        require(!vault.coreFunded(), "run before the vault's first Core deposit");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        RiskParams.Params memory p = DeployHelpers.defaultRisk();
        p.maxUnhedged = 500; // 0.5 NVDA: a missed 1 NVDA hedge shows as unhedged; chunks stay over the $10 order minimum
        p.withdrawReserve = 10e6; // the default 500 USDC is more than this demo's whole LP deposit
        p.cooldownClosedSec = 30; // testers watch their unwind live: 5 min between chunks is too long
        vault.risk().setParams(p);

        DemoOracle(market.oracle).setPrice(px * MORPHO_SCALE);

        usdc.approve(address(vault), LP_DEPOSIT);
        vault.deposit(LP_DEPOSIT, deployer);

        usdc.approve(address(morpho), LENDER_SUPPLY);
        morpho.supply(market, LENDER_SUPPLY, 0, deployer, "");

        nvdax.mint(deployer, COLLATERAL);
        nvdax.approve(address(morpho), COLLATERAL);
        morpho.supplyCollateral(market, COLLATERAL, deployer, "");
        morpho.borrow(market, Units.value(COLLATERAL, px) * LTV_BPS / 10_000, 0, deployer, deployer);
        vm.stopBroadcast();

        console.log("market C borrower", deployer);
    }
}
