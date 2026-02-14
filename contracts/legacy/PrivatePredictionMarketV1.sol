// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BitePrecompile} from "./libraries/BitePrecompile.sol";
import {IBiteSupplicant} from "./interfaces/IBiteSupplicant.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";

contract PrivatePredictionMarket is IBiteSupplicant {
    uint256 public constant CTX_GAS_LIMIT = 2_500_000;

    enum MarketState {
        CREATED,
        OPEN,
        CTX_REQUESTED,
        BATCH_PROCESSED,
        RESOLUTION_PROPOSED,
        IN_DISPUTE,
        RESOLVED,
        CANCELLED
    }

    enum Side {
        NONE,
        YES,
        NO
    }

    enum Outcome {
        UNRESOLVED,
        YES,
        NO,
        INVALID
    }

    enum OrderState {
        SUBMITTED,
        ACCEPTED,
        REJECTED,
        CLAIMED,
        REFUNDED
    }

    enum ReceiptStatus {
        SUCCESS,
        FAILURE,
        PENDING
    }

    enum ReasonCode {
        NONE,
        INVALID_ATTESTATION,
        EXPIRED_ATTESTATION,
        MARKET_NOT_OPEN,
        MARKET_NOT_CLOSED,
        INVALID_SIDE,
        STAKE_OVER_LIMIT,
        MARKET_CAP_EXCEEDED,
        TRADER_NOT_ALLOWLISTED,
        ORDER_ALREADY_PROCESSED,
        CTX_SENDER_MISMATCH,
        RESOLUTION_TOO_EARLY,
        DISPUTE_REQUIRED,
        ALREADY_CLAIMED,
        NO_WINNING_POOL,
        TRANSFER_FAILED,
        TRADER_MISMATCH,
        UNKNOWN_ORDER
    }

    struct MarketPolicy {
        uint256 id;
        address creator;
        address collateralToken;
        bytes32 questionHash;
        bytes32 metadataHash;
        uint64 openTime;
        uint64 closeTime;
        uint64 resolveBy;
        uint256 orderDepositUnit;
        uint256 maxStakePerOrder;
        uint256 maxTotalStake;
        uint256 totalEscrowed;
        uint256 totalYesStake;
        uint256 totalNoStake;
        address attestor;
        address approver;
        uint64 disputeWindowSeconds;
        bool allowlistEnabled;
        MarketState state;
        Outcome proposedOutcome;
        Outcome finalOutcome;
        uint64 disputeDeadline;
        uint256 activeBatchId;
    }

    struct OrderEnvelope {
        uint256 id;
        uint256 marketId;
        address trader;
        bytes encryptedPayload;
        bytes32 commitmentHash;
        OrderState state;
        uint256 createdAt;
        address ctxSender;
        uint256 batchId;
        Side side;
        uint256 stake;
        uint256 lastReceiptId;
        bool processed;
    }

    struct Position {
        uint256 yesStake;
        uint256 noStake;
        uint256 refundable;
        bool claimed;
    }

    struct BatchTriggerPayload {
        uint256 batchId;
        uint64 expiry;
        bytes32 ordersRoot;
    }

    struct ResolutionPayload {
        uint256 marketId;
        uint8 outcome;
        bytes32 evidenceHash;
        uint64 expiry;
    }

    struct BatchRecord {
        uint256 id;
        uint256 marketId;
        bytes32 ordersRoot;
        uint64 expiry;
        address ctxSender;
    }

    struct CreateMarketParams {
        address collateralToken;
        bytes32 questionHash;
        bytes32 metadataHash;
        uint64 openTime;
        uint64 closeTime;
        uint64 resolveBy;
        uint256 orderDepositUnit;
        uint256 maxStakePerOrder;
        uint256 maxTotalStake;
        address attestor;
        address approver;
        uint64 disputeWindowSeconds;
        bool allowlistEnabled;
        address[] allowlist;
    }

    struct DecryptedOrder {
        address trader;
        uint8 side;
        uint256 stake;
        uint256 nonce;
    }

    struct Receipt {
        uint256 receiptId;
        uint256 marketId;
        uint256 orderId;
        address trader;
        ReceiptStatus status;
        ReasonCode reasonCode;
        bool conditionPassed;
        bool executed;
        Side side;
        uint256 amount;
        uint256 timestamp;
        bytes32 evidenceHash;
    }

    uint256 public nextMarketId = 1;
    uint256 public nextOrderId = 1;
    uint256 public nextBatchId = 1;
    uint256 public nextReceiptId = 1;

    mapping(uint256 => MarketPolicy) internal markets;
    mapping(uint256 => OrderEnvelope) internal orders;
    mapping(uint256 => uint256[]) internal marketOrderIds;
    mapping(uint256 => mapping(address => Position)) internal positions;
    mapping(uint256 => mapping(address => bool)) public marketTraderAllowed;
    mapping(uint256 => BatchRecord) internal batches;
    mapping(uint256 => Receipt) internal receipts;

    event MarketCreated(
        uint256 indexed marketId,
        address indexed creator,
        bytes32 questionHash,
        address collateralToken,
        uint64 openTime,
        uint64 closeTime
    );
    event MarketOpened(uint256 indexed marketId);
    event OrderSubmitted(uint256 indexed marketId, uint256 indexed orderId, address indexed trader, bytes32 commitmentHash);
    event BatchDecryptRequested(uint256 indexed marketId, uint256 indexed batchId, bytes32 ordersRoot, address ctxSender);
    event BatchProcessed(
        uint256 indexed marketId, uint256 indexed batchId, uint256 acceptedCount, uint256 rejectedCount, bytes32 ordersRoot
    );
    event OrderProcessed(
        uint256 indexed marketId,
        uint256 indexed orderId,
        address indexed trader,
        OrderState state,
        Side side,
        uint256 stake
    );
    event ResolutionProposed(uint256 indexed marketId, Outcome outcome, uint64 disputeDeadline, bytes32 evidenceHash);
    event DisputeOpened(uint256 indexed marketId, bytes32 reasonHash);
    event ResolutionFinalized(uint256 indexed marketId, Outcome outcome, bytes32 evidenceHash);
    event PayoutClaimed(uint256 indexed marketId, address indexed trader, uint256 amount);
    event ReceiptRecorded(
        uint256 indexed receiptId,
        uint256 indexed marketId,
        uint256 indexed orderId,
        address trader,
        ReceiptStatus status,
        ReasonCode reasonCode,
        bool conditionPassed,
        bool executed,
        Side side,
        uint256 amount,
        bytes32 evidenceHash
    );

    error InvalidMarket();
    error InvalidOrder();
    error InvalidState();
    error Unauthorized();
    error InvalidSignature();

    receive() external payable {}

    function createMarket(CreateMarketParams calldata params) external returns (uint256 marketId) {
        if (_invalidMarketConfig(params)) {
            revert InvalidMarket();
        }

        marketId = nextMarketId++;
        MarketPolicy storage market = markets[marketId];
        market.id = marketId;
        market.creator = msg.sender;
        market.collateralToken = params.collateralToken;
        market.questionHash = params.questionHash;
        market.metadataHash = params.metadataHash;
        market.openTime = params.openTime;
        market.closeTime = params.closeTime;
        market.resolveBy = params.resolveBy;
        market.orderDepositUnit = params.orderDepositUnit;
        market.maxStakePerOrder = params.maxStakePerOrder;
        market.maxTotalStake = params.maxTotalStake;
        market.totalEscrowed = 0;
        market.totalYesStake = 0;
        market.totalNoStake = 0;
        market.attestor = params.attestor;
        market.approver = params.approver;
        market.disputeWindowSeconds = params.disputeWindowSeconds;
        market.allowlistEnabled = params.allowlistEnabled;
        market.state = block.timestamp >= params.openTime ? MarketState.OPEN : MarketState.CREATED;
        market.proposedOutcome = Outcome.UNRESOLVED;
        market.finalOutcome = Outcome.UNRESOLVED;

        for (uint256 i = 0; i < params.allowlist.length; i++) {
            address trader = params.allowlist[i];
            if (trader == address(0) || marketTraderAllowed[marketId][trader]) revert InvalidMarket();
            marketTraderAllowed[marketId][trader] = true;
        }

        emit MarketCreated(marketId, msg.sender, params.questionHash, params.collateralToken, params.openTime, params.closeTime);
        if (market.state == MarketState.OPEN) {
            emit MarketOpened(marketId);
        }
    }

    function _invalidMarketConfig(CreateMarketParams calldata params) internal pure returns (bool) {
        return params.collateralToken == address(0) || params.attestor == address(0) || params.approver == address(0)
            || params.questionHash == bytes32(0) || params.openTime >= params.closeTime
            || params.closeTime >= params.resolveBy || params.orderDepositUnit == 0 || params.maxStakePerOrder == 0
            || params.maxStakePerOrder > params.orderDepositUnit || params.maxTotalStake < params.orderDepositUnit
            || params.disputeWindowSeconds == 0;
    }

    function openMarket(uint256 marketId) external {
        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (msg.sender != market.creator) revert Unauthorized();
        if (market.state != MarketState.CREATED) revert InvalidState();
        if (block.timestamp < market.openTime) revert InvalidState();

        market.state = MarketState.OPEN;
        emit MarketOpened(marketId);
    }

    function submitEncryptedOrder(
        uint256 marketId,
        bytes calldata encryptedPayload,
        bytes32 commitmentHash
    ) external returns (uint256 orderId) {
        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (market.state == MarketState.CREATED && block.timestamp >= market.openTime) {
            market.state = MarketState.OPEN;
            emit MarketOpened(marketId);
        }
        if (market.state != MarketState.OPEN || block.timestamp >= market.closeTime) revert InvalidState();
        if (encryptedPayload.length == 0 || commitmentHash == bytes32(0)) revert InvalidOrder();

        if (market.allowlistEnabled && !marketTraderAllowed[marketId][msg.sender]) {
            revert Unauthorized();
        }

        if (market.totalEscrowed + market.orderDepositUnit > market.maxTotalStake) {
            revert InvalidOrder();
        }

        bool transferred = IERC20Minimal(market.collateralToken).transferFrom(msg.sender, address(this), market.orderDepositUnit);
        if (!transferred) revert InvalidOrder();

        market.totalEscrowed += market.orderDepositUnit;

        orderId = nextOrderId++;
        orders[orderId] = OrderEnvelope({
            id: orderId,
            marketId: marketId,
            trader: msg.sender,
            encryptedPayload: encryptedPayload,
            commitmentHash: commitmentHash,
            state: OrderState.SUBMITTED,
            createdAt: block.timestamp,
            ctxSender: address(0),
            batchId: 0,
            side: Side.NONE,
            stake: 0,
            lastReceiptId: 0,
            processed: false
        });

        marketOrderIds[marketId].push(orderId);
        emit OrderSubmitted(marketId, orderId, msg.sender, commitmentHash);
    }

    function triggerBatchDecrypt(
        uint256 marketId,
        uint256[] calldata orderIds,
        BatchTriggerPayload calldata payload,
        bytes calldata attestationSignature
    ) external payable {
        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (market.state != MarketState.OPEN) revert InvalidState();
        if (block.timestamp < market.closeTime) revert InvalidState();
        if (payload.expiry <= block.timestamp) revert InvalidSignature();
        if (payload.batchId != nextBatchId) revert InvalidOrder();
        if (orderIds.length == 0) revert InvalidOrder();

        bytes32 computedRoot = _computeOrdersRoot(marketId, orderIds);
        if (computedRoot != payload.ordersRoot) revert InvalidOrder();

        bytes32 digest =
            keccak256(abi.encode(address(this), block.chainid, marketId, payload.batchId, payload.ordersRoot, payload.expiry));
        address recovered = _recoverSigner(digest, attestationSignature);
        if (recovered != market.attestor) revert InvalidSignature();

        bytes[] memory encryptedArgs = _prepareEncryptedArgs(marketId, payload.batchId, orderIds);

        bytes[] memory plaintextArgs = new bytes[](6);
        plaintextArgs[0] = abi.encode(marketId);
        plaintextArgs[1] = abi.encode(payload.batchId);
        plaintextArgs[2] = abi.encode(payload.ordersRoot);
        plaintextArgs[3] = abi.encode(payload.expiry);
        plaintextArgs[4] = abi.encode(orderIds);
        plaintextArgs[5] = attestationSignature;

        uint256 gasUnits = CTX_GAS_LIMIT;
        if (msg.value > 0 && tx.gasprice > 0) {
            gasUnits = msg.value / tx.gasprice;
        }

        address ctxSender = BitePrecompile.submitCTX(gasUnits, encryptedArgs, plaintextArgs);

        BatchRecord storage batch = batches[payload.batchId];
        batch.id = payload.batchId;
        batch.marketId = marketId;
        batch.ordersRoot = payload.ordersRoot;
        batch.expiry = payload.expiry;
        batch.ctxSender = ctxSender;

        market.state = MarketState.CTX_REQUESTED;
        market.activeBatchId = payload.batchId;
        nextBatchId++;

        _assignCtxSender(orderIds, ctxSender);

        if (msg.value > 0) {
            (bool sent, ) = payable(ctxSender).call{value: msg.value}("");
            require(sent, "CTX gas transfer failed");
        }

        emit BatchDecryptRequested(marketId, payload.batchId, payload.ordersRoot, ctxSender);
    }

    function onDecrypt(
        bytes[] calldata decryptedArguments,
        bytes[] calldata plaintextArguments
    ) external override {
        if (plaintextArguments.length < 5) revert InvalidOrder();
        uint256 marketId = abi.decode(plaintextArguments[0], (uint256));
        uint256 batchId = abi.decode(plaintextArguments[1], (uint256));
        bytes32 ordersRoot = abi.decode(plaintextArguments[2], (bytes32));
        uint64 expiry = abi.decode(plaintextArguments[3], (uint64));
        uint256[] memory orderIds = abi.decode(plaintextArguments[4], (uint256[]));

        MarketPolicy storage market = markets[marketId];
        BatchRecord storage batch = batches[batchId];

        if (market.id == 0 || batch.id == 0) revert InvalidMarket();
        if (batch.marketId != marketId || market.activeBatchId != batchId) revert InvalidOrder();
        if (msg.sender != batch.ctxSender) revert Unauthorized();
        if (market.state != MarketState.CTX_REQUESTED) revert InvalidState();
        if (ordersRoot != batch.ordersRoot || expiry != batch.expiry) revert InvalidOrder();
        if (decryptedArguments.length != orderIds.length) revert InvalidOrder();

        (uint256 acceptedCount, uint256 rejectedCount) = _processBatchOrders(
            market,
            batch,
            orderIds,
            decryptedArguments
        );

        market.state = MarketState.BATCH_PROCESSED;
        emit BatchProcessed(market.id, batch.id, acceptedCount, rejectedCount, ordersRoot);
        _recordReceipt(market.id, 0, address(0), ReceiptStatus.SUCCESS, ReasonCode.NONE, true, true, Side.NONE, 0, ordersRoot);
    }

    function proposeResolution(
        ResolutionPayload calldata payload,
        bytes calldata attestationSignature
    ) external {
        MarketPolicy storage market = markets[payload.marketId];
        if (market.id == 0) revert InvalidMarket();
        if (payload.expiry <= block.timestamp) revert InvalidSignature();
        if (market.state != MarketState.BATCH_PROCESSED && market.state != MarketState.IN_DISPUTE) revert InvalidState();
        if (block.timestamp > market.resolveBy) revert InvalidState();
        if (payload.outcome > uint8(Outcome.INVALID) || payload.outcome == uint8(Outcome.UNRESOLVED)) revert InvalidOrder();

        bytes32 digest = keccak256(
            abi.encode(address(this), block.chainid, payload.marketId, payload.outcome, payload.evidenceHash, payload.expiry)
        );
        address recovered = _recoverSigner(digest, attestationSignature);
        if (recovered != market.attestor) revert InvalidSignature();

        market.proposedOutcome = Outcome(payload.outcome);
        market.state = MarketState.RESOLUTION_PROPOSED;
        market.disputeDeadline = uint64(block.timestamp + market.disputeWindowSeconds);

        emit ResolutionProposed(payload.marketId, market.proposedOutcome, market.disputeDeadline, payload.evidenceHash);
        _recordReceipt(payload.marketId, 0, msg.sender, ReceiptStatus.PENDING, ReasonCode.NONE, true, false, Side.NONE, 0, payload.evidenceHash);
    }

    function openDispute(uint256 marketId, bytes32 reasonHash) external {
        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (market.state != MarketState.RESOLUTION_PROPOSED) revert InvalidState();
        if (block.timestamp > market.disputeDeadline) revert InvalidState();

        market.state = MarketState.IN_DISPUTE;
        emit DisputeOpened(marketId, reasonHash);
        _recordReceipt(marketId, 0, msg.sender, ReceiptStatus.PENDING, ReasonCode.DISPUTE_REQUIRED, true, false, Side.NONE, 0, reasonHash);
    }

    function overrideResolution(uint256 marketId, Outcome finalOutcome, bytes32 reasonHash) external {
        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (msg.sender != market.approver) revert Unauthorized();
        if (market.state != MarketState.RESOLUTION_PROPOSED && market.state != MarketState.IN_DISPUTE) {
            revert InvalidState();
        }
        if (finalOutcome == Outcome.UNRESOLVED) revert InvalidOrder();

        market.finalOutcome = finalOutcome;
        market.state = MarketState.RESOLVED;

        emit ResolutionFinalized(marketId, finalOutcome, reasonHash);
        _recordReceipt(marketId, 0, msg.sender, ReceiptStatus.SUCCESS, ReasonCode.NONE, true, true, Side.NONE, 0, reasonHash);
    }

    function finalizeResolution(uint256 marketId) external {
        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (market.state != MarketState.RESOLUTION_PROPOSED) revert InvalidState();
        if (block.timestamp <= market.disputeDeadline) revert InvalidState();

        market.finalOutcome = market.proposedOutcome;
        market.state = MarketState.RESOLVED;

        emit ResolutionFinalized(marketId, market.finalOutcome, bytes32(0));
        _recordReceipt(marketId, 0, msg.sender, ReceiptStatus.SUCCESS, ReasonCode.NONE, true, true, Side.NONE, 0, bytes32(0));
    }

    function claimPayout(uint256 marketId) external {
        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (market.state != MarketState.RESOLVED) revert InvalidState();

        Position storage position = positions[marketId][msg.sender];
        if (position.claimed) revert InvalidState();

        uint256 payout = position.refundable;
        ReasonCode reason = ReasonCode.NONE;

        if (market.finalOutcome == Outcome.YES) {
            if (market.totalYesStake == 0) {
                payout += position.yesStake + position.noStake;
                reason = ReasonCode.NO_WINNING_POOL;
            } else {
                payout += position.yesStake + ((position.yesStake * market.totalNoStake) / market.totalYesStake);
            }
        } else if (market.finalOutcome == Outcome.NO) {
            if (market.totalNoStake == 0) {
                payout += position.yesStake + position.noStake;
                reason = ReasonCode.NO_WINNING_POOL;
            } else {
                payout += position.noStake + ((position.noStake * market.totalYesStake) / market.totalNoStake);
            }
        } else if (market.finalOutcome == Outcome.INVALID) {
            payout += position.yesStake + position.noStake;
        } else {
            revert InvalidState();
        }

        position.claimed = true;
        if (payout > 0) {
            bool ok = IERC20Minimal(market.collateralToken).transfer(msg.sender, payout);
            if (!ok) revert InvalidState();
        }

        emit PayoutClaimed(marketId, msg.sender, payout);
        _recordReceipt(marketId, 0, msg.sender, ReceiptStatus.SUCCESS, reason, true, true, Side.NONE, payout, bytes32(0));
    }

    function getMarket(uint256 marketId) external view returns (MarketPolicy memory) {
        return markets[marketId];
    }

    function getOrder(uint256 orderId) external view returns (OrderEnvelope memory) {
        return orders[orderId];
    }

    function getMarketOrderIds(uint256 marketId) external view returns (uint256[] memory) {
        return marketOrderIds[marketId];
    }

    function getPosition(uint256 marketId, address trader) external view returns (Position memory) {
        return positions[marketId][trader];
    }

    function getReceipt(uint256 receiptId) external view returns (Receipt memory) {
        return receipts[receiptId];
    }

    function _processDecryptedOrder(
        MarketPolicy storage market,
        BatchRecord storage batch,
        uint256 orderId,
        bytes calldata decrypted
    ) internal {
        OrderEnvelope storage order = orders[orderId];

        if (order.id == 0 || order.marketId != market.id) {
            _recordReceipt(
                market.id,
                orderId,
                address(0),
                ReceiptStatus.FAILURE,
                ReasonCode.UNKNOWN_ORDER,
                false,
                false,
                Side.NONE,
                0,
                batch.ordersRoot
            );
            return;
        }

        if (order.processed) {
            _recordReceipt(market.id, orderId, order.trader, ReceiptStatus.FAILURE, ReasonCode.ORDER_ALREADY_PROCESSED, false, false, Side.NONE, 0, batch.ordersRoot);
            return;
        }

        if (order.ctxSender != batch.ctxSender) {
            _rejectOrder(market, batch, order, orderId, ReasonCode.CTX_SENDER_MISMATCH);
            return;
        }

        DecryptedOrder memory d = abi.decode(decrypted, (DecryptedOrder));
        if (d.trader != order.trader) {
            _rejectOrder(market, batch, order, orderId, ReasonCode.TRADER_MISMATCH);
            return;
        }

        Side orderSide = Side(d.side);
        if (orderSide != Side.YES && orderSide != Side.NO) {
            _rejectOrder(market, batch, order, orderId, ReasonCode.INVALID_SIDE);
            return;
        }

        if (d.stake > market.maxStakePerOrder || d.stake > market.orderDepositUnit) {
            _rejectOrder(market, batch, order, orderId, ReasonCode.STAKE_OVER_LIMIT);
            return;
        }

        _acceptOrder(market, batch, order, orderId, orderSide, d.stake);
    }

    function _processBatchOrders(
        MarketPolicy storage market,
        BatchRecord storage batch,
        uint256[] memory orderIds,
        bytes[] calldata decryptedArguments
    ) internal returns (uint256 acceptedCount, uint256 rejectedCount) {
        for (uint256 i = 0; i < orderIds.length; i++) {
            uint256 orderId = orderIds[i];
            bool wasProcessed = orders[orderId].processed;
            _processDecryptedOrder(market, batch, orderId, decryptedArguments[i]);

            if (!wasProcessed && orders[orderId].processed) {
                if (orders[orderId].state == OrderState.ACCEPTED) {
                    acceptedCount++;
                } else if (orders[orderId].state == OrderState.REJECTED) {
                    rejectedCount++;
                }
            }
        }
    }

    function _rejectOrder(
        MarketPolicy storage market,
        BatchRecord storage batch,
        OrderEnvelope storage order,
        uint256 orderId,
        ReasonCode reason
    ) internal {
        order.processed = true;
        order.state = OrderState.REJECTED;
        positions[market.id][order.trader].refundable += market.orderDepositUnit;
        _recordReceipt(
            market.id,
            orderId,
            order.trader,
            ReceiptStatus.FAILURE,
            reason,
            false,
            false,
            Side.NONE,
            market.orderDepositUnit,
            batch.ordersRoot
        );
    }

    function _acceptOrder(
        MarketPolicy storage market,
        BatchRecord storage batch,
        OrderEnvelope storage order,
        uint256 orderId,
        Side orderSide,
        uint256 stake
    ) internal {
        order.processed = true;
        order.state = OrderState.ACCEPTED;
        order.side = orderSide;
        order.stake = stake;

        Position storage position = positions[market.id][order.trader];
        if (orderSide == Side.YES) {
            position.yesStake += stake;
            market.totalYesStake += stake;
        } else {
            position.noStake += stake;
            market.totalNoStake += stake;
        }

        uint256 refund = market.orderDepositUnit - stake;
        if (refund > 0) {
            position.refundable += refund;
        }

        emit OrderProcessed(market.id, orderId, order.trader, order.state, order.side, stake);
        _recordOrderSuccess(market.id, orderId, order.trader, orderSide, stake, batch.ordersRoot);
    }

    function _recordOrderSuccess(
        uint256 marketId,
        uint256 orderId,
        address trader,
        Side side,
        uint256 amount,
        bytes32 evidenceHash
    ) internal {
        _recordReceipt(
            marketId,
            orderId,
            trader,
            ReceiptStatus.SUCCESS,
            ReasonCode.NONE,
            true,
            true,
            side,
            amount,
            evidenceHash
        );
    }

    function _computeOrdersRoot(uint256 marketId, uint256[] calldata orderIds) internal view returns (bytes32 rolling) {
        rolling = keccak256("");
        for (uint256 i = 0; i < orderIds.length; i++) {
            OrderEnvelope storage order = orders[orderIds[i]];
            if (order.id == 0 || order.marketId != marketId) revert InvalidOrder();
            rolling = keccak256(abi.encodePacked(rolling, orderIds[i], order.commitmentHash, order.trader));
        }
    }

    function _prepareEncryptedArgs(
        uint256 marketId,
        uint256 batchId,
        uint256[] calldata orderIds
    ) internal returns (bytes[] memory encryptedArgs) {
        encryptedArgs = new bytes[](orderIds.length);
        for (uint256 i = 0; i < orderIds.length; i++) {
            OrderEnvelope storage order = orders[orderIds[i]];
            if (order.id == 0 || order.marketId != marketId || order.processed) revert InvalidOrder();
            encryptedArgs[i] = order.encryptedPayload;
            order.batchId = batchId;
        }
    }

    function _assignCtxSender(uint256[] calldata orderIds, address ctxSender) internal {
        for (uint256 i = 0; i < orderIds.length; i++) {
            orders[orderIds[i]].ctxSender = ctxSender;
        }
    }

    function _recordReceipt(
        uint256 marketId,
        uint256 orderId,
        address trader,
        ReceiptStatus status,
        ReasonCode reason,
        bool conditionPassed,
        bool executed,
        Side side,
        uint256 amount,
        bytes32 evidenceHash
    ) internal {
        uint256 receiptId = nextReceiptId++;
        receipts[receiptId] = Receipt({
            receiptId: receiptId,
            marketId: marketId,
            orderId: orderId,
            trader: trader,
            status: status,
            reasonCode: reason,
            conditionPassed: conditionPassed,
            executed: executed,
            side: side,
            amount: amount,
            timestamp: block.timestamp,
            evidenceHash: evidenceHash
        });

        if (orderId != 0 && orders[orderId].id != 0) {
            orders[orderId].lastReceiptId = receiptId;
        }

        emit ReceiptRecorded(
            receiptId,
            marketId,
            orderId,
            trader,
            status,
            reason,
            conditionPassed,
            executed,
            side,
            amount,
            evidenceHash
        );
    }

    function _recoverSigner(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }

        if (v < 27) {
            v += 27;
        }

        if (v != 27 && v != 28) return address(0);

        bytes32 ethSignedDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(ethSignedDigest, v, r, s);
    }
}
