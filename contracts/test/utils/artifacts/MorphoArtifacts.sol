// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// Compiles real Morpho Blue so tests can `deployCode("Morpho.sol:Morpho", ...)` without importing it
// (Morpho pins solc 0.8.19, our sources need 0.8.28).
import {Morpho} from "@morpho-blue/Morpho.sol";
import {IrmMock} from "@morpho-blue/mocks/IrmMock.sol";
