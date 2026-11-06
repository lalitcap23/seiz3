// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IMockMorpho {
    function price() external view returns (uint256);
    function lltv() external view returns (uint256);
    function borrowerCount() external view returns (uint256);
    function borrowerAt(uint256 index) external view returns (address);
    function getBorrower(address borrower) external view returns (uint256 collateral, uint256 borrowAssets);
    function liquidate(address borrower, uint256 requestedSeized) external returns (uint256 seized, uint256 repaid);
}

contract MockMorpho is IMockMorpho {
    struct Position {
        uint256 collateral;
        uint256 borrowAssets;
    }

    uint256 private constant WAD = 1e18;
    uint256 private constant PRICE_SCALE = 1e36;
    uint256 private constant BPS = 10_000;

    address public owner;
    address public vault;
    uint256 public price;
    uint256 public lltv;

    address[] private _borrowers;
    mapping(address => Position) private _positions;
    mapping(address => bool) private _known;

    event BorrowerSet(address indexed borrower, uint256 collateral, uint256 borrowAssets);
    event Liquidated(address indexed borrower, uint256 seized, uint256 repaid);
    event PriceSet(uint256 price);
    event LltvSet(uint256 lltv);

    modifier onlyOwner() {
        require(msg.sender == owner, "morpho: not owner");
        _;
    }

    modifier onlyVault() {
        require(msg.sender == vault, "morpho: not vault");
        _;
    }

    constructor(uint256 price_, uint256 lltv_) {
        require(lltv_ <= BPS * WAD / BPS, "morpho: lltv too high");
        owner = msg.sender;
        price = price_;
        lltv = lltv_;
    }

    function setVault(address vault_) external onlyOwner {
        require(vault == address(0), "morpho: vault set");
        require(vault_ != address(0), "morpho: zero vault");
        vault = vault_;
    }

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
        emit PriceSet(price_);
    }

    function setLltv(uint256 lltv_) external onlyOwner {
        lltv = lltv_;
        emit LltvSet(lltv_);
    }

    function setBorrower(address borrower, uint256 collateral, uint256 borrowAssets) external onlyOwner {
        require(borrower != address(0), "morpho: zero borrower");
        if (!_known[borrower]) {
            _known[borrower] = true;
            _borrowers.push(borrower);
        }
        _positions[borrower] = Position({collateral: collateral, borrowAssets: borrowAssets});
        emit BorrowerSet(borrower, collateral, borrowAssets);
    }

    function borrowerCount() external view returns (uint256) {
        return _borrowers.length;
    }

    function borrowerAt(uint256 index) external view returns (address) {
        return _borrowers[index];
    }

    function getBorrower(address borrower) external view returns (uint256 collateral, uint256 borrowAssets) {
        Position memory p = _positions[borrower];
        return (p.collateral, p.borrowAssets);
    }

    function positionValue(address borrower) external view returns (uint256) {
        return _positions[borrower].collateral * price / PRICE_SCALE;
    }

    function liquidate(address borrower, uint256 requestedSeized)
        external
        onlyVault
        returns (uint256 seized, uint256 repaid)
    {
        require(requestedSeized > 0, "morpho: zero seize");
        Position storage p = _positions[borrower];
        require(p.collateral >= requestedSeized, "morpho: seize exceeds collateral");

        seized = requestedSeized;
        repaid = seized * price / PRICE_SCALE;
        if (repaid > p.borrowAssets) repaid = p.borrowAssets;

        p.collateral -= seized;
        p.borrowAssets -= repaid;
        emit Liquidated(borrower, seized, repaid);
    }
}
