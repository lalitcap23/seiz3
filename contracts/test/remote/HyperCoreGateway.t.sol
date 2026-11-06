// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";
import {ReceiverTemplate} from "../../src/cre/ReceiverTemplate.sol";
import {HyperCoreGateway} from "../../src/remote/HyperCoreGateway.sol";

contract HyperCoreGatewayTest is Test {
    uint32 constant PERP_INDEX = 650_002; // testnet xyz:NVDA
    uint32 constant DEX = 65;

    address owner = makeAddr("owner");
    address forwarder = makeAddr("forwarder");
    address relayer = makeAddr("relayer");
    address vault = makeAddr("vault");
    HyperCoreGateway g;

    function setUp() public {
        vm.warp(1_760_000_000);
        g = new HyperCoreGateway(owner, forwarder, relayer, PERP_INDEX, DEX);
        vm.prank(owner);
        g.setAccount(vault);
    }

    function _snap(uint64 at, int64 szi, uint64 executed) internal pure returns (HyperCoreGateway.Snapshot memory) {
        return HyperCoreGateway.Snapshot({
            observedAt: at,
            szi: szi,
            entryNtl: uint64(szi < 0 ? -szi : szi) * 212_000,
            accountValue: 120e6,
            marginUsed: 40e6,
            ntlPos: 212e6,
            spotUsdcWei: 5e8,
            oraclePx: 212_000,
            markPx: 212_100,
            leverage: 3,
            exists: true,
            executedNonce: executed
        });
    }

    function _relay(HyperCoreGateway.Snapshot memory s) internal {
        vm.prank(relayer);
        g.relay(s);
    }

    function _order() internal returns (uint64) {
        vm.prank(vault);
        return g.placeOrder(750_002, false, 210_000e5, 1000e5, false, 42);
    }

    // ─── wiring ───────────────────────────────────────────────────────────

    function test_setAccount_once() public {
        vm.prank(owner);
        vm.expectRevert(HyperCoreGateway.AccountAlreadySet.selector);
        g.setAccount(address(1));
    }

    function test_admin_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        g.setRelayer(address(this));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        g.setMaxStateAge(1);
        assertEq(g.owner(), owner);
        assertEq(g.getForwarderAddress(), forwarder);
    }

    // ─── orders ───────────────────────────────────────────────────────────

    function test_placeOrder_onlyTheVault() public {
        vm.expectRevert(HyperCoreGateway.NotAccount.selector);
        g.placeOrder(750_002, false, 1, 1, false, 1);
    }

    function test_placeOrder_numbersAndStoresIt() public {
        vm.expectEmit(address(g));
        emit HyperCoreGateway.OrderRequested(1, 750_002, false, 210_000e5, 1000e5, false, 3, 42);
        assertEq(_order(), 1);
        assertEq(_order(), 2);
        HyperCoreGateway.Order memory o = g.orders(2);
        assertEq(o.asset, 750_002);
        assertEq(o.limitPx, 210_000e5);
        assertEq(o.sz, 1000e5);
        assertEq(o.tif, 3);
        assertEq(o.cloid, 42);
        assertEq(o.requestedAt, block.timestamp);
        assertEq(g.actionCount(), 2);
        assertFalse(g.settled());
    }

    // ─── snapshots ────────────────────────────────────────────────────────

    function test_relay_onlyTheRelayer() public {
        vm.expectRevert(HyperCoreGateway.NotRelayer.selector);
        g.relay(_snap(uint64(block.timestamp), 0, 0));
    }

    function test_relay_servesPrecompileShapes() public {
        _relay(_snap(uint64(block.timestamp), -1000, 0));

        PrecompileLib.Position memory p = g.position(vault, PERP_INDEX);
        assertEq(p.szi, -1000);
        assertEq(p.entryNtl, 1000 * 212_000);
        assertEq(p.leverage, 3);
        assertTrue(p.isIsolated);
        assertEq(g.oraclePx(PERP_INDEX), 212_000);
        assertEq(g.markPx(PERP_INDEX), 212_100);
        PrecompileLib.AccountMarginSummary memory m = g.accountMarginSummary(DEX, vault);
        assertEq(m.accountValue, 120e6);
        assertEq(m.marginUsed, 40e6);
        assertEq(m.ntlPos, 212e6);
        assertEq(m.rawUsd, 120e6 + 212e6, "short: raw USD = value + notional");
        assertEq(g.spotBalance(vault, 0).total, 5e8);
        assertTrue(g.coreUserExists(vault));
        assertTrue(g.fresh());
    }

    function test_reads_otherUsersAndDexesAreEmpty() public {
        _relay(_snap(uint64(block.timestamp), -1000, 0));
        address other = makeAddr("other");
        assertEq(g.position(other, PERP_INDEX).szi, 0);
        assertEq(g.accountMarginSummary(DEX, other).accountValue, 0);
        assertEq(g.accountMarginSummary(DEX + 1, vault).accountValue, 0);
        assertEq(g.spotBalance(other, 0).total, 0);
        assertEq(g.spotBalance(vault, 1).total, 0, "USDC only");
        assertFalse(g.coreUserExists(other));
    }

    function test_reads_unknownAssetReverts() public {
        _relay(_snap(uint64(block.timestamp), 0, 0));
        vm.expectRevert(abi.encodeWithSelector(HyperCoreGateway.UnknownAsset.selector, PERP_INDEX + 1));
        g.oraclePx(PERP_INDEX + 1);
    }

    function test_reads_failClosedWhenStale() public {
        vm.expectRevert(abi.encodeWithSelector(HyperCoreGateway.StaleState.selector, 0));
        g.oraclePx(PERP_INDEX); // nothing observed yet

        uint64 at = uint64(block.timestamp);
        _relay(_snap(at, 0, 0));
        vm.warp(block.timestamp + g.maxStateAge());
        assertEq(g.oraclePx(PERP_INDEX), 212_000, "exactly maxStateAge old is still fresh");
        vm.warp(block.timestamp + 1);
        assertFalse(g.fresh());
        vm.expectRevert(abi.encodeWithSelector(HyperCoreGateway.StaleState.selector, at));
        g.position(vault, PERP_INDEX);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreGateway.StaleState.selector, at));
        g.accountMarginSummary(DEX, vault);
        assertTrue(g.coreUserExists(vault), "an account never disappears");
    }

    function test_relay_keepsOnlyNewerObservations() public {
        _relay(_snap(uint64(block.timestamp), -1000, 0));
        vm.expectEmit(address(g));
        emit HyperCoreGateway.SnapshotIgnored(relayer, uint64(block.timestamp - 5), uint64(block.timestamp));
        _relay(_snap(uint64(block.timestamp - 5), -2000, 0));
        assertEq(g.lastSnapshot().szi, -1000);
    }

    function test_relay_rejectsTheFuture() public {
        uint64 at = uint64(block.timestamp + 61);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreGateway.ReportFromFuture.selector, at));
        g.relay(_snap(at, 0, 0));
    }

    // ─── acknowledgements ─────────────────────────────────────────────────

    function test_ack_settlesOrders() public {
        _order();
        _relay(_snap(uint64(block.timestamp), 0, 0));
        assertFalse(g.settled());
        vm.warp(block.timestamp + 3);
        vm.expectEmit(address(g));
        emit HyperCoreGateway.OrdersAcknowledged(1, uint64(block.timestamp));
        _relay(_snap(uint64(block.timestamp), -1000, 1));
        assertTrue(g.settled());
        assertEq(g.executedNonce(), 1);
        assertEq(g.executedAt(), block.timestamp);
        assertEq(g.lastSnapshot().executedNonce, 1);
    }

    function test_ack_cannotRunAheadOfOrders() public {
        _order();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreGateway.BadAck.selector, 2, 1));
        g.relay(_snap(uint64(block.timestamp), 0, 2));
    }

    function test_ack_countsEvenWhenTheStateIsOlder() public {
        _order();
        vm.warp(block.timestamp + 10);
        vm.prank(forwarder); // the DON observed after the relayer did
        g.onReport("", abi.encode(_snap(uint64(block.timestamp), -1000, 0)));
        _relay(_snap(uint64(block.timestamp - 4), -1000, 1));
        assertEq(g.executedNonce(), 1);
        assertTrue(g.settled());
        assertEq(g.lastSnapshot().observedAt, block.timestamp, "the newer DON state stays");
    }

    // ─── CRE ──────────────────────────────────────────────────────────────

    function test_cre_onlyTheForwarder() public {
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), forwarder));
        g.onReport("", abi.encode(_snap(uint64(block.timestamp), 0, 0)));
    }

    function test_cre_postsStateButNeverAcknowledges() public {
        _order();
        vm.prank(forwarder);
        g.onReport("", abi.encode(_snap(uint64(block.timestamp), -1000, 1)));
        assertEq(g.lastSnapshot().szi, -1000);
        assertEq(g.executedNonce(), 0);
        assertEq(g.lastSnapshot().executedNonce, 0);
        assertFalse(g.settled());
    }

    function test_cre_olderReportIsIgnoredNotReverted() public {
        _relay(_snap(uint64(block.timestamp), -1000, 0));
        vm.prank(forwarder);
        g.onReport("", abi.encode(_snap(uint64(block.timestamp - 30), 0, 0))); // a DON run that raced the relayer
        assertEq(g.lastSnapshot().szi, -1000);
    }

    function test_relayerOff_leavesTheDonOnly() public {
        vm.prank(owner);
        g.setRelayer(address(0));
        vm.prank(relayer);
        vm.expectRevert(HyperCoreGateway.NotRelayer.selector);
        g.relay(_snap(uint64(block.timestamp), 0, 0));
    }
}
