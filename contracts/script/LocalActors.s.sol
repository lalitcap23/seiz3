// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "@morpho-blue/interfaces/IMorpho.sol";

import {Seiz3Vault} from "../src/Seiz3Vault.sol";
import {RiskParams} from "../src/RiskParams.sol";
import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {Units} from "../src/libs/Units.sol";
import {MockHyperCore} from "../test/utils/MockHyperCore.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice Last step of scripts/local-stack.sh, after Deploy → CreateMarkets → SeedPool: HyperCore credits the
///         activation deposit, LP money goes in, the vault's xyz margin is funded, and a borrower opens the market C
///         position the keeper liquidates once the price drops. RiskParams timings are shortened so a whole
///         liquidate → hedge → unwind run takes about a minute.
///
///   BORROWER_PK=… forge script script/LocalActors.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil 0> --broadcast
contract LocalActors is Script {
    uint256 constant LP_DEPOSIT = 100_000e6;
    uint256 constant CORE_MARGIN = 20_000e6; // marginTarget with defaultRisk: 50k max liquidation × 1.2 / 3
    uint256 constant LENDER_SUPPLY = 1_000_000e6;
    uint256 constant COLLATERAL = 100e18;
    uint256 constant START_PX = 217e6; // CreateMarkets' and SeedPool's default
    uint256 constant LTV_BPS = 7600; // under 77% LLTV now, over it after a ~2% drop

    function run() external {
        string memory dep = vm.readFile(DeployHelpers.deploymentPath(vm.projectRoot(), "local"));
        string memory chain = vm.readFile(DeployHelpers.deploymentPath(vm.projectRoot(), "local-chain"));
        Seiz3Vault vault = Seiz3Vault(vm.parseJsonAddress(dep, ".vault"));
        MockHyperCore core = MockHyperCore(vm.parseJsonAddress(chain, ".core"));
        IMorpho morpho = vault.morpho();
        IERC20 usdc = vault.usdc();
        MockNVDAx nvdax = MockNVDAx(address(vault.nvdax()));
        MarketParams memory market =
            morpho.idToMarketParams(Id.wrap(vm.parseJsonBytes32(dep, ".markets.C_seiz3.id")));
        uint256 borrowerPk = vm.envUint("BORROWER_PK");
        address borrower = vm.addr(borrowerPk);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        core.processBlock(); // HyperCore credits the activation deposit Deploy.s.sol sent

        RiskParams.Params memory p = DeployHelpers.defaultRisk();
        p.maxUnhedged = 10_000; // 10 NVDA unwind chunks
        p.orderDelaySec = 2;
        p.cooldownOpenSec = 2;
        p.cooldownClosedSec = 2;
        p.transitBlocks = 2;
        vault.risk().setParams(p);
        vault.risk().setMarketOpen(true);

        usdc.approve(address(vault), LP_DEPOSIT);
        vault.deposit(LP_DEPOSIT, deployer);
        vault.topUpMargin(CORE_MARGIN);

        usdc.approve(address(morpho), LENDER_SUPPLY);
        morpho.supply(market, LENDER_SUPPLY, 0, deployer, "");
        nvdax.mint(borrower, COLLATERAL);
        vm.stopBroadcast();

        vm.startBroadcast(borrowerPk);
        nvdax.approve(address(morpho), COLLATERAL);
        morpho.supplyCollateral(market, COLLATERAL, borrower, "");
        morpho.borrow(market, Units.value(COLLATERAL, START_PX) * LTV_BPS / 10_000, 0, borrower, borrower);
        vm.stopBroadcast();

        vm.startBroadcast();
        core.processBlock(); // the margin deposit lands on xyz
        vm.stopBroadcast();

        console.log("market C borrower", borrower);
    }
}
