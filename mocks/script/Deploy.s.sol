// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockMorpho} from "../src/MockMorpho.sol";
import {MockVault} from "../src/MockVault.sol";
import {IAfterbellVaultMock} from "../src/interfaces/IAfterbellVault.sol";

interface Vm {
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function envOr(string calldata name, address defaultValue) external returns (address);
    function envOr(string calldata name, bytes32 defaultValue) external returns (bytes32);
    function toString(address value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
    function writeFile(string calldata path, string calldata data) external;
}

contract Deploy {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant USDC = 1e6;
    uint256 private constant NVDAX = 1e18;

    function run() external {
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address keeper = vm.envOr("KEEPER_ADDRESS", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));
        address borrowerA = vm.envOr("BORROWER_A", address(0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC));
        address borrowerB = vm.envOr("BORROWER_B", address(0x90F79bf6EB2c4f870365E785982E1f101E93b906));

        uint256 price = vm.envOr("PRICE", uint256(100 * 1e26));
        uint256 lltv = vm.envOr("LLTV", uint256(0.8e18));
        bytes32 marketId = vm.envOr("MARKET_ID", keccak256("afterbell.mock.market"));
        uint256 idleUsdc = vm.envOr("IDLE_USDC", uint256(100_000 * USDC));
        uint256 coreUsdc = vm.envOr("CORE_USDC", uint256(0));
        uint256 orderDelaySec = vm.envOr("ORDER_DELAY_SEC", uint256(5));
        uint256 unwindCooldownSec = vm.envOr("UNWIND_COOLDOWN_SEC", uint256(10));

        IAfterbellVaultMock.Risk memory risk = IAfterbellVaultMock.Risk({
            maxLiquidation: vm.envOr("MAX_LIQUIDATION", uint256(1_000 * USDC)),
            hedgeLeverage: _u32(vm.envOr("HEDGE_LEVERAGE", uint256(3))),
            marginBufferBps: _u32(vm.envOr("MARGIN_BUFFER_BPS", uint256(1000))),
            maxUnhedgedBps: _u32(vm.envOr("MAX_UNHEDGED_BPS", uint256(200))),
            maxSlippageBps: _u32(vm.envOr("MAX_SLIPPAGE_BPS", uint256(100))),
            oracleBandBps: _u32(vm.envOr("ORACLE_BAND_BPS", uint256(200))),
            maxTries: _u8(vm.envOr("MAX_TRIES", uint256(3))),
            orderDelaySec: _u32(orderDelaySec),
            unwindCooldownSec: _u32(unwindCooldownSec)
        });

        vm.startBroadcast(deployerKey);
        MockMorpho morpho = new MockMorpho(price, lltv);
        MockVault vault = new MockVault(address(morpho), marketId, keeper, idleUsdc, coreUsdc, risk);
        morpho.setVault(address(vault));
        morpho.setBorrower(borrowerA, 10 * NVDAX, 900 * USDC);
        morpho.setBorrower(borrowerB, 10 * NVDAX, 700 * USDC);
        vm.stopBroadcast();

        string memory path = vm.envOr("DEPLOYMENTS_PATH", string("./shared/deployments.json"));
        string memory json = string.concat(
            "{\"chainId\":",
            vm.toString(block.chainid),
            ",\"vault\":\"",
            vm.toString(address(vault)),
            "\",\"morpho\":\"",
            vm.toString(address(morpho)),
            "\",\"marketId\":\"",
            vm.toString(marketId),
            "\",\"lltv\":\"",
            vm.toString(lltv),
            "\",\"price\":\"",
            vm.toString(price),
            "\",\"szDecimals\":2,\"orderDelaySec\":",
            vm.toString(orderDelaySec),
            ",\"unwindCooldownOpenSec\":2,\"keeperAddress\":\"",
            vm.toString(keeper),
            "\",\"borrowers\":[",
            _borrowerJson(borrowerA, 10 * NVDAX, 900 * USDC, "liquidatable"),
            ",",
            _borrowerJson(borrowerB, 10 * NVDAX, 700 * USDC, "healthy"),
            "]}"
        );
        vm.writeFile(path, json);
    }

    function _borrowerJson(address borrower, uint256 collateral, uint256 borrowAssets, string memory label)
        private
        view
        returns (string memory)
    {
        return string.concat(
            "{\"address\":\"",
            vm.toString(borrower),
            "\",\"collateral\":\"",
            vm.toString(collateral),
            "\",\"borrowAssets\":\"",
            vm.toString(borrowAssets),
            "\",\"label\":\"",
            label,
            "\"}"
        );
    }

    function _u32(uint256 value) private pure returns (uint32) {
        require(value <= type(uint32).max, "deploy: uint32 overflow");
        return uint32(value);
    }

    function _u8(uint256 value) private pure returns (uint8) {
        require(value <= type(uint8).max, "deploy: uint8 overflow");
        return uint8(value);
    }
}
