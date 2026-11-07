// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "@morpho-blue/interfaces/IMorpho.sol";

import {RiskParams} from "../src/RiskParams.sol";
import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {DemoOracle} from "../src/mocks/DemoOracle.sol";
import {Units} from "../src/libs/Units.sol";
import {Seiz3VaultRemote} from "../src/remote/Seiz3VaultRemote.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice The demo's actors on Base Sepolia, after RemoteInfra → DeployRemote → CreateMarkets →
///         SeedPool: risk params sized for a 1 NVDAx round, LP money in the vault, a lender in market C, and a market C
///         borrower just under the 77% LLTV at PRICE_USD6 (HyperCore's NVDA oracle). Then a ~1.4% drop of market C's
///         oracle (`scripts/base-stack.sh crash`) makes it liquidatable while staying inside the vault's 1.5% band.
/// Runs before `activateCore`: until then deposits don't read the gateway, which has nothing to serve yet.
///
///   NETWORK=base-sepolia PRICE_USD6=212290000 forge script script/RemoteActors.s.sol --rpc-url base_sepolia --broadcast
contract RemoteActors is Script {
    uint256 constant MORPHO_SCALE = 1e18; // DemoOracle price = usd6 × 1e18 (CreateMarkets)

    function run() external {
        string memory network = vm.envOr("NETWORK", string("base-sepolia"));
        string memory dep = vm.readFile(DeployHelpers.deploymentPath(vm.projectRoot(), network));
        Seiz3VaultRemote vault = Seiz3VaultRemote(vm.parseJsonAddress(dep, ".vault"));
        IMorpho morpho = vault.morpho();
        IERC20 usdc = vault.usdc();
        MockNVDAx nvdax = MockNVDAx(address(vault.nvdax()));
        MarketParams memory market =
            morpho.idToMarketParams(Id.wrap(vm.parseJsonBytes32(dep, ".markets.C_seiz3.id")));
        uint256 px = vm.envUint("PRICE_USD6");
        uint256 lpDeposit = vm.envOr("LP_DEPOSIT", uint256(200e6));
        uint256 lenderSupply = vm.envOr("LENDER_SUPPLY", uint256(180e6));
        uint256 collateral = vm.envOr("COLLATERAL", uint256(1e18));
        uint256 ltvBps = vm.envOr("LTV_BPS", uint256(7680)); // under 77% at PRICE_USD6, over it after a ~0.3% drop
        uint256 borrowerPk = vm.envOr("BORROWER_PK", uint256(0));
        require(!vault.coreFunded(), "run before activateCore");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        RiskParams.Params memory p = DeployHelpers.defaultRisk();
        p.maxUnhedged = 500; // 0.5 NVDA: a missed 1 NVDA hedge shows as unhedged; chunks stay over the $10 order minimum
        p.withdrawReserve = 10e6; // the default 500 USDC is more than this demo's whole LP deposit
        p.orderDelaySec = uint32(vm.envOr("ORDER_DELAY_SEC", uint256(2))); // syncHedge also waits for the relayer's ack
        p.cooldownOpenSec = uint32(vm.envOr("COOLDOWN_OPEN_SEC", uint256(10)));
        p.cooldownClosedSec = uint32(vm.envOr("COOLDOWN_CLOSED_SEC", uint256(30)));
        p.maxImpactBps = uint16(vm.envOr("MAX_IMPACT_BPS", uint256(120))); // ~0.05 NVDAx chunks clear the $10 minimum
        p.maxSlippageBps = uint16(vm.envOr("MAX_SLIPPAGE_BPS", uint256(150)));
        vault.risk().setParams(p);
        if (vm.envOr("MARKET_OPEN", false)) vault.risk().setMarketOpen(true);

        DemoOracle(market.oracle).setPrice(px * MORPHO_SCALE);

        usdc.approve(address(vault), lpDeposit);
        vault.deposit(lpDeposit, deployer);

        usdc.approve(address(morpho), lenderSupply);
        morpho.supply(market, lenderSupply, 0, deployer, "");

        address borrower = borrowerPk == 0 ? deployer : vm.addr(borrowerPk);
        nvdax.mint(borrower, collateral);
        vm.stopBroadcast();

        if (borrowerPk == 0) vm.startBroadcast();
        else vm.startBroadcast(borrowerPk);
        nvdax.approve(address(morpho), collateral);
        morpho.supplyCollateral(market, collateral, borrower, "");
        morpho.borrow(market, Units.value(collateral, px) * ltvBps / 10_000, 0, borrower, borrower);
        vm.stopBroadcast();

        console.log("market C borrower", borrower);
    }
}
