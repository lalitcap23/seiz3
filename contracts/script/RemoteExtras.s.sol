// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "@morpho-blue/interfaces/IMorpho.sol";

import {Faucet} from "../src/mocks/Faucet.sol";
import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {MockUSDC} from "../test/utils/AfterbellBase.sol";
import {AfterbellVaultRemote} from "../src/remote/AfterbellVaultRemote.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice TestnetExtras.s.sol for the Base Sepolia architecture: what people trying the /try page need, after
///         DeployRemote → CreateMarkets.
///   - a Faucet (NVDAx to borrow against, USDC to lend / deposit / buy with, Base ETH for gas), funded, with the API's
///     relay key as its operator so a brand-new wallet can start without gas;
///   - lender liquidity in the three Morpho markets (C is the one testers borrow from);
///   - LP cash in the vault, so it can repay several testers' liquidations before its unwinds pay it back.
/// The test USDC (RemoteInfra) and MockNVDAx are mintable by the deployer. Merges `faucet` into deployments/<NETWORK>.json.
/// Once the vault is activated, run it with the relayer up: a deposit prices shares from the gateway.
///
///   NETWORK=base-sepolia FAUCET_OPERATOR=0x… forge script script/RemoteExtras.s.sol --rpc-url base_sepolia --broadcast
contract RemoteExtras is Script {
    function run() external {
        string memory network = vm.envOr("NETWORK", string("base-sepolia"));
        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), network);
        string memory dep = vm.readFile(path);
        AfterbellVaultRemote vault = AfterbellVaultRemote(vm.parseJsonAddress(dep, ".vault"));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Faucet faucet = _faucet(dep, vault, deployer);
        _lend(dep, vault, deployer);
        _lp(vault, deployer);
        vm.stopBroadcast();

        vm.serializeJson("deployment", dep);
        vm.writeJson(vm.serializeAddress("deployment", "faucet", address(faucet)), path);
        console.log("faucet", address(faucet));
        console.log("vault idle USDC", vault.usdc().balanceOf(address(vault)));
    }

    /// @dev The deployment's Faucet if it has one, else a new one; funded either way.
    function _faucet(string memory dep, AfterbellVaultRemote vault, address deployer) internal returns (Faucet faucet) {
        address existing = vm.keyExistsJson(dep, ".faucet") ? vm.parseJsonAddress(dep, ".faucet") : address(0);
        if (existing != address(0) && existing.code.length > 0) {
            faucet = Faucet(payable(existing));
        } else {
            faucet = new Faucet(
                deployer,
                vault.nvdax(),
                vault.usdc(),
                vm.envOr("FAUCET_NVDAX", uint256(1e18)), // ~$212 of collateral: one liquidation clears every minimum
                vm.envOr("FAUCET_USDC", uint256(500e6)), // lend, deposit into the vault, buy from the hook
                vm.envOr("FAUCET_NATIVE", uint256(0.0005 ether)), // hundreds of Base Sepolia transactions
                uint64(vm.envOr("FAUCET_COOLDOWN", uint256(600)))
            );
        }
        address operator = vm.envOr("FAUCET_OPERATOR", address(0));
        if (operator != address(0)) faucet.setOperator(operator, true);
        MockNVDAx(address(vault.nvdax())).mint(address(faucet), vm.envOr("FAUCET_FUND_NVDAX", uint256(50e18)));
        MockUSDC(address(vault.usdc())).mint(address(faucet), vm.envOr("FAUCET_FUND_USDC", uint256(50_000e6)));
        uint256 native = vm.envOr("FAUCET_FUND_NATIVE", uint256(0.005 ether));
        if (native > 0) payable(address(faucet)).transfer(native);
    }

    /// @dev Lender liquidity: market C carries the testers' loans, A and B the dashboard's other two.
    function _lend(string memory dep, AfterbellVaultRemote vault, address deployer) internal {
        _supply(dep, vault, deployer, "A_naive", 500e6);
        _supply(dep, vault, deployer, "B_conservative", 500e6);
        _supply(dep, vault, deployer, "C_afterbell", vm.envOr("LENDER_SUPPLY_C", uint256(5000e6)));
    }

    function _supply(string memory dep, AfterbellVaultRemote vault, address deployer, string memory name, uint256 amount)
        internal
    {
        IMorpho morpho = vault.morpho();
        MarketParams memory mp =
            morpho.idToMarketParams(Id.wrap(vm.parseJsonBytes32(dep, string.concat(".markets.", name, ".id"))));
        MockUSDC(address(vault.usdc())).mint(deployer, amount);
        vault.usdc().approve(address(morpho), amount);
        morpho.supply(mp, amount, 0, deployer, "");
    }

    /// @dev LP cash: each liquidation is repaid from the vault's idle USDC until its unwind sells the stock.
    function _lp(AfterbellVaultRemote vault, address deployer) internal {
        uint256 lp = vm.envOr("LP_TOPUP", uint256(2000e6));
        if (lp == 0) return;
        MockUSDC(address(vault.usdc())).mint(deployer, lp);
        vault.usdc().approve(address(vault), lp);
        vault.deposit(lp, deployer);
    }
}
