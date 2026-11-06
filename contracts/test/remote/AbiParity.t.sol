// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAfterbellVault} from "../../src/interfaces/IAfterbellVault.sol";
import {AfterbellHook} from "../../src/AfterbellHook.sol";
import {AfterbellHookRemote} from "../../src/remote/AfterbellHookRemote.sol";
import {AfterbellVaultRemote} from "../../src/remote/AfterbellVaultRemote.sol";

/// @notice The keeper, API, bots, replay and the deploy scripts talk to AfterbellVault and AfterbellHook through ABIs
///         generated from them. The Base Sepolia contracts must answer every one of those calls and emit every one of
///         those events, so the same off-chain code drives either chain.
contract AbiParityTest is Test {
    function _keys(string memory artifact, string memory path) internal view returns (string[] memory) {
        return vm.parseJsonKeys(vm.readFile(string.concat(vm.projectRoot(), "/out/", artifact)), path);
    }

    function _assertSuperset(string memory original, string memory remote, string memory path) internal view {
        string[] memory want = _keys(original, path);
        string[] memory have = _keys(remote, path);
        for (uint256 i; i < want.length; ++i) {
            bool found;
            for (uint256 j; j < have.length && !found; ++j) {
                found = keccak256(bytes(want[i])) == keccak256(bytes(have[j]));
            }
            assertTrue(found, string.concat(remote, " lacks ", want[i]));
        }
    }

    function test_vault_answersEveryAfterbellVaultCall() public view {
        _assertSuperset(
            "AfterbellVault.sol/AfterbellVault.json",
            "AfterbellVaultRemote.sol/AfterbellVaultRemote.json",
            ".methodIdentifiers"
        );
    }

    function test_hook_answersEveryAfterbellHookCall() public view {
        _assertSuperset(
            "AfterbellHook.sol/AfterbellHook.json", "AfterbellHookRemote.sol/AfterbellHookRemote.json", ".methodIdentifiers"
        );
    }

    /// @dev The vaults' events all come from IAfterbellVault, which both implement; the hooks declare their own.
    function test_hook_emitsTheSameEvents() public pure {
        assertEq(AfterbellHook.InventoryFill.selector, AfterbellHookRemote.InventoryFill.selector);
        assertEq(AfterbellHook.VaultSet.selector, AfterbellHookRemote.VaultSet.selector);
        assertEq(AfterbellHook.SettingsSet.selector, AfterbellHookRemote.SettingsSet.selector);
    }

    function test_vault_isAnIAfterbellVault() public pure {
        assertEq(type(IAfterbellVault).interfaceId, type(IAfterbellVault).interfaceId); // compile-time: both implement it
        AfterbellVaultRemote v;
        IAfterbellVault i = v; // fails to compile if AfterbellVaultRemote stopped implementing the interface
        assertEq(address(i), address(0));
    }
}
