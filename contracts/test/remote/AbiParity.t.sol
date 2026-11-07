// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ISeiz3Vault} from "../../src/interfaces/ISeiz3Vault.sol";
import {Seiz3Hook} from "../../src/Seiz3Hook.sol";
import {Seiz3HookRemote} from "../../src/remote/Seiz3HookRemote.sol";
import {Seiz3VaultRemote} from "../../src/remote/Seiz3VaultRemote.sol";

/// @notice The keeper, API, bots, replay and the deploy scripts talk to Seiz3Vault and Seiz3Hook through ABIs
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

    function test_vault_answersEverySeiz3VaultCall() public view {
        _assertSuperset(
            "Seiz3Vault.sol/Seiz3Vault.json",
            "Seiz3VaultRemote.sol/Seiz3VaultRemote.json",
            ".methodIdentifiers"
        );
    }

    function test_hook_answersEverySeiz3HookCall() public view {
        _assertSuperset(
            "Seiz3Hook.sol/Seiz3Hook.json", "Seiz3HookRemote.sol/Seiz3HookRemote.json", ".methodIdentifiers"
        );
    }

    /// @dev The vaults' events all come from ISeiz3Vault, which both implement; the hooks declare their own.
    function test_hook_emitsTheSameEvents() public pure {
        assertEq(Seiz3Hook.InventoryFill.selector, Seiz3HookRemote.InventoryFill.selector);
        assertEq(Seiz3Hook.VaultSet.selector, Seiz3HookRemote.VaultSet.selector);
        assertEq(Seiz3Hook.SettingsSet.selector, Seiz3HookRemote.SettingsSet.selector);
    }

    function test_vault_isAnISeiz3Vault() public pure {
        assertEq(type(ISeiz3Vault).interfaceId, type(ISeiz3Vault).interfaceId); // compile-time: both implement it
        Seiz3VaultRemote v;
        ISeiz3Vault i = v; // fails to compile if Seiz3VaultRemote stopped implementing the interface
        assertEq(address(i), address(0));
    }
}
