// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PrivatePredictionMarket.sol";
import "../src/mocks/MockUSDC.sol";

contract PrivatePredictionMarketHarness is PrivatePredictionMarket {
    function forceSetMarketState(uint256 marketId, MarketState state) external {
        markets[marketId].state = state;
    }

    function forceSetupBatch(
        uint256 marketId,
        uint256 batchId,
        bytes32 ordersRoot,
        uint64 expiry,
        address ctxSender,
        uint256[] calldata orderIds
    ) external {
        batches[batchId] = BatchRecord({
            id: batchId,
            marketId: marketId,
            ordersRoot: ordersRoot,
            expiry: expiry,
            ctxSender: ctxSender
        });

        markets[marketId].state = MarketState.ORDER_CTX_REQUESTED;
        markets[marketId].activeBatchId = batchId;

        for (uint256 i = 0; i < orderIds.length; i++) {
            orders[orderIds[i]].batchId = batchId;
            orders[orderIds[i]].ctxSender = ctxSender;
        }
    }

    function forceSetupOutcomeCtx(uint256 marketId, address ctxSender) external {
        markets[marketId].outcomeCtxSender = ctxSender;
        markets[marketId].state = MarketState.OUTCOME_CTX_REQUESTED;
    }
}

contract PrivatePredictionMarketTest is Test {
    MockUSDC internal token;
    PrivatePredictionMarketHarness internal app;

    address internal creator = makeAddr("creator");
    address internal traderA = makeAddr("traderA");
    address internal traderB = makeAddr("traderB");
    address internal approver = makeAddr("approver");

    uint256 internal attestorPk = 0xA11CE;
    address internal attestor;

    uint256 internal constant DEPOSIT = 10_000_000;

    function setUp() external {
        attestor = vm.addr(attestorPk);

        token = new MockUSDC();
        app = new PrivatePredictionMarketHarness();

        token.mint(traderA, 100_000_000);
        token.mint(traderB, 100_000_000);

        vm.prank(traderA);
        token.approve(address(app), type(uint256).max);
        vm.prank(traderB);
        token.approve(address(app), type(uint256).max);
    }

    function testCreateMarketRevertsOnInvalidConfig() external {
        PrivatePredictionMarket.CreateMarketParams memory params = _defaultParams();
        params.openTime = uint64(block.timestamp + 100);
        params.closeTime = uint64(block.timestamp + 100);

        vm.expectRevert(PrivatePredictionMarket.InvalidMarket.selector);
        vm.prank(creator);
        app.createMarket(params);
    }

    function testSubmitOrderRespectsAllowlistAndCap() external {
        address[] memory allowlist = new address[](1);
        allowlist[0] = traderA;
        uint256 marketId = _createMarket(allowlist, DEPOSIT);

        vm.expectRevert(PrivatePredictionMarket.Unauthorized.selector);
        vm.prank(traderB);
        app.submitEncryptedOrder(marketId, hex"1234", keccak256("order-b"));

        vm.prank(traderA);
        app.submitEncryptedOrder(marketId, hex"11", keccak256("order-a-1"));

        vm.expectRevert(PrivatePredictionMarket.InvalidOrder.selector);
        vm.prank(traderA);
        app.submitEncryptedOrder(marketId, hex"22", keccak256("order-a-2"));
    }

    function testOnDecryptAcceptsOrderAndUpdatesPools() external {
        uint256 marketId = _createMarket(_emptyAllowlist(), DEPOSIT * 100);

        // Two sealed limit orders that should clear at ~60/40 (YES price 6000 bps).
        bytes memory decryptedA = abi.encode(
            PrivatePredictionMarket.DecryptedOrder({
                trader: traderA,
                side: uint8(PrivatePredictionMarket.Side.YES),
                maxCost: 6_000_000,
                limitPriceBps: 10_000,
                nonce: 1
            })
        );
        bytes memory decryptedB = abi.encode(
            PrivatePredictionMarket.DecryptedOrder({
                trader: traderB,
                side: uint8(PrivatePredictionMarket.Side.NO),
                maxCost: 4_000_000,
                limitPriceBps: 10_000,
                nonce: 2
            })
        );

        uint256 orderA = _submitOrder(traderA, marketId, hex"1111", keccak256(decryptedA));
        uint256 orderB = _submitOrder(traderB, marketId, hex"2222", keccak256(decryptedB));

        uint256[] memory orderIds = new uint256[](2);
        orderIds[0] = orderA;
        orderIds[1] = orderB;

        bytes32 ordersRoot = _computeOrdersRoot(marketId, orderIds);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        address ctxSender = makeAddr("ctxSender");

        app.forceSetupBatch(marketId, 1, ordersRoot, expiry, ctxSender, orderIds);

        bytes[] memory decrypted = new bytes[](2);
        decrypted[0] = decryptedA;
        decrypted[1] = decryptedB;

        bytes[] memory plain = _plaintextOrderBatchArgs(marketId, 1, ordersRoot, expiry, orderIds);

        vm.prank(ctxSender);
        app.onDecrypt(decrypted, plain);

        PrivatePredictionMarket.MarketPolicy memory market = app.getMarket(marketId);
        assertEq(uint256(market.state), uint256(PrivatePredictionMarket.MarketState.BATCH_PROCESSED));
        assertEq(market.clearingYesPriceBps, 6000);
        assertEq(market.matchedLots, 1000);
        assertEq(market.totalYesStake, 6_000_000);
        assertEq(market.totalNoStake, 4_000_000);

        PrivatePredictionMarket.Position memory posA = app.getPosition(marketId, traderA);
        PrivatePredictionMarket.Position memory posB = app.getPosition(marketId, traderB);
        assertEq(posA.yesLots, 1000);
        assertEq(posA.noLots, 0);
        assertEq(posA.refundable, 4_000_000);
        assertEq(posB.yesLots, 0);
        assertEq(posB.noLots, 1000);
        assertEq(posB.refundable, 6_000_000);

        PrivatePredictionMarket.OrderEnvelope memory orderViewA = app.getOrder(orderA);
        PrivatePredictionMarket.OrderEnvelope memory orderViewB = app.getOrder(orderB);
        assertEq(uint256(orderViewA.state), uint256(PrivatePredictionMarket.OrderState.FILLED));
        assertEq(uint256(orderViewB.state), uint256(PrivatePredictionMarket.OrderState.FILLED));

        // 2 order receipts + 1 batch receipt
        assertEq(app.nextReceiptId(), 4);
    }

    function testOnDecryptRejectsInvalidSideAndCreditsRefund() external {
        uint256 marketId = _createMarket(_emptyAllowlist(), DEPOSIT * 100);

        bytes memory decryptedOrder = abi.encode(
            PrivatePredictionMarket.DecryptedOrder({
                trader: traderA,
                side: 3,
                maxCost: 5_000_000,
                limitPriceBps: 10_000,
                nonce: 1
            })
        );
        uint256 orderId = _submitOrder(traderA, marketId, hex"bbbb", keccak256(decryptedOrder));
        uint256[] memory orderIds = _singleOrder(orderId);
        bytes32 ordersRoot = _computeOrdersRoot(marketId, orderIds);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        address ctxSender = makeAddr("ctxSender");

        app.forceSetupBatch(marketId, 1, ordersRoot, expiry, ctxSender, orderIds);

        bytes[] memory decrypted = new bytes[](1);
        decrypted[0] = decryptedOrder;

        bytes[] memory plain = _plaintextOrderBatchArgs(marketId, 1, ordersRoot, expiry, orderIds);

        vm.prank(ctxSender);
        app.onDecrypt(decrypted, plain);

        PrivatePredictionMarket.OrderEnvelope memory order = app.getOrder(orderId);
        assertEq(uint256(order.state), uint256(PrivatePredictionMarket.OrderState.REJECTED));

        PrivatePredictionMarket.Position memory position = app.getPosition(marketId, traderA);
        assertEq(position.yesLots, 0);
        assertEq(position.noLots, 0);
        assertEq(position.refundable, DEPOSIT);

        PrivatePredictionMarket.Receipt memory r1 = app.getReceipt(1);
        assertEq(uint256(r1.reasonCode), uint256(PrivatePredictionMarket.ReasonCode.INVALID_SIDE));
    }

    function testOnDecryptOutcomeRevealSetsResolutionProposed() external {
        uint256 marketId = _createMarket(_emptyAllowlist(), DEPOSIT * 100);
        app.forceSetMarketState(marketId, PrivatePredictionMarket.MarketState.BATCH_PROCESSED);

        bytes32 evidenceHash = keccak256("resolution-evidence");
        bytes memory decryptedOutcome = abi.encode(
            PrivatePredictionMarket.DecryptedOutcome({
                marketId: marketId,
                outcome: uint8(PrivatePredictionMarket.Outcome.YES),
                evidenceHash: evidenceHash,
                nonce: 123
            })
        );

        bytes32 commitmentHash = keccak256(decryptedOutcome);
        vm.prank(attestor);
        app.commitEncryptedOutcome(marketId, decryptedOutcome, commitmentHash);

        address ctxSender = makeAddr("outcomeCtxSender");
        app.forceSetupOutcomeCtx(marketId, ctxSender);

        bytes[] memory decrypted = new bytes[](1);
        decrypted[0] = decryptedOutcome;
        bytes[] memory plain = _plaintextOutcomeArgs(marketId, uint64(block.timestamp + 1 hours), commitmentHash);

        vm.prank(ctxSender);
        app.onDecrypt(decrypted, plain);

        PrivatePredictionMarket.MarketPolicy memory market = app.getMarket(marketId);
        assertEq(uint256(market.state), uint256(PrivatePredictionMarket.MarketState.RESOLUTION_PROPOSED));
        assertEq(uint256(market.proposedOutcome), uint256(PrivatePredictionMarket.Outcome.YES));
        assertEq(market.outcomeEvidenceHash, evidenceHash);
        assertTrue(market.disputeDeadline > block.timestamp);
    }

    function testClaimPayoutAfterResolutionYesOutcome() external {
        uint256 marketId = _createMarket(_emptyAllowlist(), DEPOSIT * 100);

        bytes memory decryptedA = abi.encode(
            PrivatePredictionMarket.DecryptedOrder({
                trader: traderA,
                side: uint8(PrivatePredictionMarket.Side.YES),
                maxCost: 6_000_000,
                limitPriceBps: 10_000,
                nonce: 1
            })
        );
        bytes memory decryptedB = abi.encode(
            PrivatePredictionMarket.DecryptedOrder({
                trader: traderB,
                side: uint8(PrivatePredictionMarket.Side.NO),
                maxCost: 4_000_000,
                limitPriceBps: 10_000,
                nonce: 2
            })
        );

        uint256 orderA = _submitOrder(traderA, marketId, hex"1111", keccak256(decryptedA));
        uint256 orderB = _submitOrder(traderB, marketId, hex"2222", keccak256(decryptedB));

        uint256[] memory orderIds = new uint256[](2);
        orderIds[0] = orderA;
        orderIds[1] = orderB;
        bytes32 ordersRoot = _computeOrdersRoot(marketId, orderIds);
        uint64 batchExpiry = uint64(block.timestamp + 1 hours);
        address ctxSender = makeAddr("ctxSender");

        app.forceSetupBatch(marketId, 1, ordersRoot, batchExpiry, ctxSender, orderIds);

        bytes[] memory decrypted = new bytes[](2);
        decrypted[0] = decryptedA;
        decrypted[1] = decryptedB;

        bytes[] memory plain = _plaintextArgs(marketId, 1, ordersRoot, batchExpiry, orderIds);
        vm.prank(ctxSender);
        app.onDecrypt(decrypted, plain);

        // Override resolution directly (approver path) for claim gating in tests.
        vm.prank(approver);
        app.overrideResolution(marketId, PrivatePredictionMarket.Outcome.YES, keccak256("override"));

        uint256 beforeBalance = token.balanceOf(traderA);
        vm.prank(traderA);
        app.claimPayout(marketId);
        uint256 afterBalance = token.balanceOf(traderA);

        // Payout = refundable (4 USDC) + winning lots (1000 lots * 0.01 USDC) = 14 USDC.
        assertEq(afterBalance - beforeBalance, 14_000_000);

        PrivatePredictionMarket.Position memory position = app.getPosition(marketId, traderA);
        assertTrue(position.claimed);
    }

    function _createMarket(address[] memory allowlist, uint256 maxTotalStake) internal returns (uint256 marketId) {
        PrivatePredictionMarket.CreateMarketParams memory params = _defaultParams();
        params.allowlistEnabled = allowlist.length > 0;
        params.allowlist = allowlist;
        params.maxTotalStake = maxTotalStake;

        vm.prank(creator);
        marketId = app.createMarket(params);
    }

    function _submitOrder(address trader, uint256 marketId, bytes memory encryptedPayload, bytes32 commitmentHash)
        internal
        returns (uint256 orderId)
    {
        vm.prank(trader);
        orderId = app.submitEncryptedOrder(marketId, encryptedPayload, commitmentHash);
    }

    function _defaultParams() internal view returns (PrivatePredictionMarket.CreateMarketParams memory params) {
        params.collateralToken = address(token);
        params.questionHash = keccak256("question");
        params.metadataHash = keccak256("metadata");
        params.openTime = uint64(block.timestamp - 1);
        params.closeTime = uint64(block.timestamp + 1 days);
        params.resolveBy = uint64(block.timestamp + 2 days);
        params.orderDepositUnit = DEPOSIT;
        params.maxStakePerOrder = DEPOSIT;
        params.maxTotalStake = DEPOSIT * 100;
        params.attestor = attestor;
        params.approver = approver;
        params.disputeWindowSeconds = 1 hours;
        params.allowlistEnabled = false;
        params.allowlist = new address[](0);
    }

    function _computeOrdersRoot(uint256 marketId, uint256[] memory orderIds) internal view returns (bytes32 rolling) {
        rolling = keccak256("");
        for (uint256 i = 0; i < orderIds.length; i++) {
            PrivatePredictionMarket.OrderEnvelope memory order = app.getOrder(orderIds[i]);
            require(order.marketId == marketId, "market mismatch");
            rolling = keccak256(abi.encodePacked(rolling, orderIds[i], order.commitmentHash, order.trader));
        }
    }

    function _singleOrder(uint256 orderId) internal pure returns (uint256[] memory orderIds) {
        orderIds = new uint256[](1);
        orderIds[0] = orderId;
    }

    function _plaintextArgs(
        uint256 marketId,
        uint256 batchId,
        bytes32 ordersRoot,
        uint64 expiry,
        uint256[] memory orderIds
    ) internal pure returns (bytes[] memory plain) {
        plain = _plaintextOrderBatchArgs(marketId, batchId, ordersRoot, expiry, orderIds);
    }

    function _plaintextOrderBatchArgs(
        uint256 marketId,
        uint256 batchId,
        bytes32 ordersRoot,
        uint64 expiry,
        uint256[] memory orderIds
    ) internal pure returns (bytes[] memory plain) {
        plain = new bytes[](6);
        plain[0] = abi.encode(uint8(PrivatePredictionMarket.CtxAction.ORDER_BATCH));
        plain[1] = abi.encode(marketId);
        plain[2] = abi.encode(batchId);
        plain[3] = abi.encode(ordersRoot);
        plain[4] = abi.encode(expiry);
        plain[5] = abi.encode(orderIds);
    }

    function _plaintextOutcomeArgs(
        uint256 marketId,
        uint64 expiry,
        bytes32 commitmentHash
    ) internal pure returns (bytes[] memory plain) {
        plain = new bytes[](4);
        plain[0] = abi.encode(uint8(PrivatePredictionMarket.CtxAction.OUTCOME_REVEAL));
        plain[1] = abi.encode(marketId);
        plain[2] = abi.encode(expiry);
        plain[3] = abi.encode(commitmentHash);
    }

    function _signDigest(uint256 privateKey, bytes32 digest) internal returns (bytes memory sig) {
        bytes32 ethSignedDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethSignedDigest);
        sig = abi.encodePacked(r, s, v);
    }

    function _emptyAllowlist() internal pure returns (address[] memory allowlist) {
        allowlist = new address[](0);
    }
}
