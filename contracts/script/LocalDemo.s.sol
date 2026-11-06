// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "@morpho-blue/interfaces/IMorpho.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {RiskParams} from "../src/RiskParams.sol";
import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {Units} from "../src/libs/Units.sol";
import {MockHyperCore} from "../test/utils/MockHyperCore.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice The three-market demo's "before judging" state on the local stack, after Deploy → CreateMarkets → a thin
///         SeedPool (scripts/local-stack.sh demo): a lender and a borrower in each market, NaiveLiquidator funded for
///         market A's shortfall, LP money and Core margin in the vault, weekend risk params. The replay steps then play
///         the show: scene → marketA → marketB → marketC → monday.
/// A and C borrow 76% against a 77% LLTV, so the scene's drop puts them under water; B borrows 30% against 38.5%
/// and stays healthy, the conservative market's point.
///
///   BORROWER_A_PK=… BORROWER_B_PK=… BORROWER_C_PK=… forge script script/LocalDemo.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil 0> --broadcast
contract LocalDemo is Script {
    uint256 constant COLLATERAL = 100e18;
    uint256 constant START_PX = 217e6; // CreateMarkets' and SeedPool's default
    uint256 constant LENDER_SUPPLY = 100_000e6;
    uint256 constant LP_DEPOSIT = 100_000e6;
    uint256 constant CORE_MARGIN = 20_000e6; // marginTarget with defaultRisk: 50k max liquidation × 1.2 / 3
    uint256 constant NAIVE_FUNDING = 20_000e6; // covers market A's whole repayment: the dump pays back next to nothing

    struct Borrower {
        string market;
        uint256 pk;
        uint256 ltvBps;
    }

    function run() external {
        string memory dep = vm.readFile(DeployHelpers.deploymentPath(vm.projectRoot(), "local"));
        string memory chain = vm.readFile(DeployHelpers.deploymentPath(vm.projectRoot(), "local-chain"));
        AfterbellVault vault = AfterbellVault(vm.parseJsonAddress(dep, ".vault"));
        MockHyperCore core = MockHyperCore(vm.parseJsonAddress(chain, ".core"));
        IMorpho morpho = vault.morpho();
        IERC20 usdc = vault.usdc();
        MockNVDAx nvdax = MockNVDAx(address(vault.nvdax()));

        Borrower[3] memory borrowers = [
            Borrower("A_naive", vm.envUint("BORROWER_A_PK"), 7600),
            Borrower("B_conservative", vm.envUint("BORROWER_B_PK"), 3000),
            Borrower("C_afterbell", vm.envUint("BORROWER_C_PK"), 7600)
        ];

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
        vault.risk().setMarketOpen(false); // the weekend: monday flips it

        usdc.approve(address(vault), LP_DEPOSIT);
        vault.deposit(LP_DEPOSIT, deployer);
        vault.topUpMargin(CORE_MARGIN);
        usdc.transfer(vm.parseJsonAddress(dep, ".naiveLiquidator"), NAIVE_FUNDING);

        for (uint256 i; i < 3; ++i) {
            MarketParams memory market = _market(morpho, dep, borrowers[i].market);
            usdc.approve(address(morpho), LENDER_SUPPLY);
            morpho.supply(market, LENDER_SUPPLY, 0, deployer, "");
            nvdax.mint(vm.addr(borrowers[i].pk), COLLATERAL);
        }
        vm.stopBroadcast();

        for (uint256 i; i < 3; ++i) {
            MarketParams memory market = _market(morpho, dep, borrowers[i].market);
            address borrower = vm.addr(borrowers[i].pk);
            vm.startBroadcast(borrowers[i].pk);
            nvdax.approve(address(morpho), COLLATERAL);
            morpho.supplyCollateral(market, COLLATERAL, borrower, "");
            morpho.borrow(market, Units.value(COLLATERAL, START_PX) * borrowers[i].ltvBps / 10_000, 0, borrower, borrower);
            vm.stopBroadcast();
            console.log(borrowers[i].market, borrower);
        }

        vm.startBroadcast();
        core.processBlock(); // the margin deposit lands on xyz
        vm.stopBroadcast();
    }

    function _market(IMorpho morpho, string memory dep, string memory name) internal view returns (MarketParams memory) {
        return morpho.idToMarketParams(Id.wrap(vm.parseJsonBytes32(dep, string.concat(".markets.", name, ".id"))));
    }
}
