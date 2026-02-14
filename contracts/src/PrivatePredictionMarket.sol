// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BitePrecompile} from "./libraries/BitePrecompile.sol";
import {IBiteSupplicant} from "./interfaces/IBiteSupplicant.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";

contract PrivatePredictionMarket is IBiteSupplicant {
    uint256 public constant CTX_GAS_LIMIT = 2_500_000;
    uint16 public constant PRICE_BPS_MAX = 10_000;
    uint16 public constant PRICE_BPS_MIN = 1;
    // 1 lot pays 0.01 USDC (10,000 micro-units) if it wins.
    // Using lots keeps clearing math integer when price is expressed in basis points.
    uint256 public constant LOT_SIZE = 10_000;

    enum CtxAction {
        ORDER_BATCH,
        OUTCOME_REVEAL
    }

    enum MarketState {
        CREATED,
        OPEN,
        ORDER_CTX_REQUESTED,
        BATCH_PROCESSED,
        OUTCOME_COMMITTED,
        OUTCOME_CTX_REQUESTED,
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
        FILLED,
        PARTIALLY_FILLED,
        REJECTED,
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
        MAX_COST_OVER_LIMIT,
        MARKET_CAP_EXCEEDED,
        TRADER_NOT_ALLOWLISTED,
        ORDER_ALREADY_PROCESSED,
        CTX_SENDER_MISMATCH,
        DISPUTE_REQUIRED,
        TRANSFER_FAILED,
        TRADER_MISMATCH,
        UNKNOWN_ORDER,
        COMMITMENT_MISMATCH,
        INVALID_LIMIT_PRICE,
        LIMIT_NOT_MET,
        UNMATCHED,
        PARTIAL_FILL,
        OUTCOME_NOT_COMMITTED,
        INVALID_OUTCOME,
        OUTCOME_COMMITMENT_MISMATCH,
        OUTCOME_CTX_SENDER_MISMATCH,
        ALREADY_CLAIMED
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
        uint16 clearingYesPriceBps;
        uint256 matchedLots;
        address attestor;
        address approver;
        uint64 disputeWindowSeconds;
        bool allowlistEnabled;
        MarketState state;
        Outcome proposedOutcome;
        Outcome finalOutcome;
        uint64 disputeDeadline;
        uint256 activeBatchId;
        bytes32 outcomeCommitmentHash;
        address outcomeCtxSender;
        bytes32 outcomeEvidenceHash;
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
        uint256 maxCost;
        uint16 limitPriceBps;
        uint256 filledLots;
        uint256 stake; // spent cost (USDC micro-units) for the filled lots
        uint256 lastReceiptId;
        bool processed;
    }

    struct Position {
        uint256 yesLots;
        uint256 noLots;
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
        uint256 maxCost;
        uint16 limitPriceBps;
        uint256 nonce;
    }

    struct DecryptedOutcome {
        uint256 marketId;
        uint8 outcome;
        bytes32 evidenceHash;
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
    mapping(uint256 => bytes) internal marketOutcomeCiphertext;

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
        uint256 indexed marketId,
        uint256 indexed batchId,
        uint256 filledCount,
        uint256 rejectedCount,
        uint16 clearingYesPriceBps,
        uint256 matchedLots,
        bytes32 ordersRoot
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
    event OutcomeCommitted(uint256 indexed marketId, bytes32 commitmentHash);
    event OutcomeDecryptRequested(uint256 indexed marketId, uint64 expiry, address ctxSender);
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
        market.clearingYesPriceBps = 5000;
        market.matchedLots = 0;
        market.attestor = params.attestor;
        market.approver = params.approver;
        market.disputeWindowSeconds = params.disputeWindowSeconds;
        market.allowlistEnabled = params.allowlistEnabled;
        market.state = block.timestamp >= params.openTime ? MarketState.OPEN : MarketState.CREATED;
        market.proposedOutcome = Outcome.UNRESOLVED;
        market.finalOutcome = Outcome.UNRESOLVED;
        market.outcomeCommitmentHash = bytes32(0);
        market.outcomeCtxSender = address(0);
        market.outcomeEvidenceHash = bytes32(0);

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
            maxCost: 0,
            limitPriceBps: 0,
            filledLots: 0,
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
        plaintextArgs[0] = abi.encode(uint8(CtxAction.ORDER_BATCH));
        plaintextArgs[1] = abi.encode(marketId);
        plaintextArgs[2] = abi.encode(payload.batchId);
        plaintextArgs[3] = abi.encode(payload.ordersRoot);
        plaintextArgs[4] = abi.encode(payload.expiry);
        plaintextArgs[5] = abi.encode(orderIds);

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

        market.state = MarketState.ORDER_CTX_REQUESTED;
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
        if (plaintextArguments.length == 0) revert InvalidOrder();
        uint8 action = abi.decode(plaintextArguments[0], (uint8));
        if (action == uint8(CtxAction.ORDER_BATCH)) {
            _onDecryptOrderBatch(decryptedArguments, plaintextArguments);
            return;
        }
        if (action == uint8(CtxAction.OUTCOME_REVEAL)) {
            _onDecryptOutcome(decryptedArguments, plaintextArguments);
            return;
        }
        revert InvalidOrder();
    }

    function commitEncryptedOutcome(
        uint256 marketId,
        bytes calldata encryptedOutcome,
        bytes32 commitmentHash
    ) external {
        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (msg.sender != market.attestor) revert Unauthorized();
        if (market.state != MarketState.BATCH_PROCESSED && market.state != MarketState.OUTCOME_COMMITTED) {
            revert InvalidState();
        }
        if (block.timestamp > market.resolveBy) revert InvalidState();
        if (encryptedOutcome.length == 0 || commitmentHash == bytes32(0)) revert InvalidOrder();
        if (market.state == MarketState.OUTCOME_COMMITTED && market.outcomeCtxSender != address(0)) revert InvalidState();

        marketOutcomeCiphertext[marketId] = encryptedOutcome;
        market.outcomeCommitmentHash = commitmentHash;
        market.outcomeEvidenceHash = bytes32(0);
        market.state = MarketState.OUTCOME_COMMITTED;

        emit OutcomeCommitted(marketId, commitmentHash);
        _recordReceipt(marketId, 0, msg.sender, ReceiptStatus.PENDING, ReasonCode.NONE, true, false, Side.NONE, 0, commitmentHash);
    }

    function triggerOutcomeDecrypt(
        uint256 marketId,
        uint64 expiry,
        bytes calldata attestationSignature
    ) external payable {
        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (market.state != MarketState.OUTCOME_COMMITTED) revert InvalidState();
        if (expiry <= block.timestamp) revert InvalidSignature();
        if (market.outcomeCommitmentHash == bytes32(0) || marketOutcomeCiphertext[marketId].length == 0) {
            revert InvalidOrder();
        }

        bytes32 digest = keccak256(abi.encode(address(this), block.chainid, marketId, market.outcomeCommitmentHash, expiry));
        address recovered = _recoverSigner(digest, attestationSignature);
        if (recovered != market.attestor) revert InvalidSignature();

        bytes[] memory encryptedArgs = new bytes[](1);
        encryptedArgs[0] = marketOutcomeCiphertext[marketId];

        bytes[] memory plaintextArgs = new bytes[](4);
        plaintextArgs[0] = abi.encode(uint8(CtxAction.OUTCOME_REVEAL));
        plaintextArgs[1] = abi.encode(marketId);
        plaintextArgs[2] = abi.encode(expiry);
        plaintextArgs[3] = abi.encode(market.outcomeCommitmentHash);

        uint256 gasUnits = CTX_GAS_LIMIT;
        if (msg.value > 0 && tx.gasprice > 0) {
            gasUnits = msg.value / tx.gasprice;
        }

        address ctxSender = BitePrecompile.submitCTX(gasUnits, encryptedArgs, plaintextArgs);
        market.outcomeCtxSender = ctxSender;
        market.state = MarketState.OUTCOME_CTX_REQUESTED;

        if (msg.value > 0) {
            (bool sent, ) = payable(ctxSender).call{value: msg.value}("");
            require(sent, "CTX gas transfer failed");
        }

        emit OutcomeDecryptRequested(marketId, expiry, ctxSender);
        _recordReceipt(marketId, 0, msg.sender, ReceiptStatus.PENDING, ReasonCode.NONE, true, false, Side.NONE, 0, market.outcomeCommitmentHash);
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
            payout += position.yesLots * LOT_SIZE;
        } else if (market.finalOutcome == Outcome.NO) {
            payout += position.noLots * LOT_SIZE;
        } else if (market.finalOutcome == Outcome.INVALID) {
            // Refund executed costs (lots * clearing cost per lot) for both sides.
            uint256 yesCostPerLot = uint256(market.clearingYesPriceBps);
            uint256 noCostPerLot = uint256(PRICE_BPS_MAX - market.clearingYesPriceBps);
            payout += (position.yesLots * yesCostPerLot) + (position.noLots * noCostPerLot);
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
        // Legacy per-order processing removed in favor of sealed batch clearing.
        market;
        batch;
        orderId;
        decrypted;
        revert InvalidState();
    }

    function _processBatchOrders(
        MarketPolicy storage market,
        BatchRecord storage batch,
        uint256[] memory orderIds,
        bytes[] calldata decryptedArguments
    ) internal returns (uint256 filledCount, uint256 rejectedCount, uint16 clearingYesPriceBps, uint256 matchedLots) {
        (filledCount, rejectedCount, clearingYesPriceBps, matchedLots) = _sealedBatchClear(
            market,
            batch,
            orderIds,
            decryptedArguments
        );
    }

    function _sealedBatchClear(
        MarketPolicy storage market,
        BatchRecord storage batch,
        uint256[] memory orderIds,
        bytes[] calldata decryptedArguments
    ) internal returns (uint256 filledCount, uint256 rejectedCount, uint16 clearingYesPriceBps, uint256 matchedLots) {
        uint256 validCount = 0;

        // Pass 1: validate + decode (invalid orders are processed and refunded immediately).
        for (uint256 i = 0; i < orderIds.length; i++) {
            uint256 orderId = orderIds[i];
            OrderEnvelope storage order = orders[orderId];

            if (order.id == 0 || order.marketId != market.id) {
                rejectedCount++;
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
                continue;
            }

            if (order.processed) {
                rejectedCount++;
                _recordReceipt(
                    market.id,
                    orderId,
                    order.trader,
                    ReceiptStatus.FAILURE,
                    ReasonCode.ORDER_ALREADY_PROCESSED,
                    false,
                    false,
                    Side.NONE,
                    0,
                    batch.ordersRoot
                );
                continue;
            }

            if (order.ctxSender != batch.ctxSender) {
                rejectedCount++;
                _rejectOrderFullRefund(market, batch, order, orderId, ReasonCode.CTX_SENDER_MISMATCH);
                continue;
            }

            if (keccak256(decryptedArguments[i]) != order.commitmentHash) {
                rejectedCount++;
                _rejectOrderFullRefund(market, batch, order, orderId, ReasonCode.COMMITMENT_MISMATCH);
                continue;
            }

            DecryptedOrder memory d = abi.decode(decryptedArguments[i], (DecryptedOrder));
            if (d.trader != order.trader) {
                rejectedCount++;
                _rejectOrderFullRefund(market, batch, order, orderId, ReasonCode.TRADER_MISMATCH);
                continue;
            }

            Side orderSide = Side(d.side);
            if (orderSide != Side.YES && orderSide != Side.NO) {
                rejectedCount++;
                _rejectOrderFullRefund(market, batch, order, orderId, ReasonCode.INVALID_SIDE);
                continue;
            }

            if (d.maxCost == 0 || d.maxCost > market.maxStakePerOrder || d.maxCost > market.orderDepositUnit) {
                rejectedCount++;
                _rejectOrderFullRefund(market, batch, order, orderId, ReasonCode.MAX_COST_OVER_LIMIT);
                continue;
            }

            if (d.limitPriceBps < PRICE_BPS_MIN || d.limitPriceBps > PRICE_BPS_MAX) {
                rejectedCount++;
                _rejectOrderFullRefund(market, batch, order, orderId, ReasonCode.INVALID_LIMIT_PRICE);
                continue;
            }

            // Persist decrypted (now public) fields to the envelope for clearing.
            order.side = orderSide;
            order.maxCost = d.maxCost;
            order.limitPriceBps = d.limitPriceBps;
            order.filledLots = 0;
            order.stake = 0;
            validCount++;
        }

        // No valid orders -> keep default clearing values, still return.
        if (validCount == 0) {
            return (0, rejectedCount, 5000, 0);
        }

        (clearingYesPriceBps, matchedLots) = _selectClearingPriceFromOrders(orderIds, market.id);
        market.clearingYesPriceBps = clearingYesPriceBps;

        uint16 yesCostPerLot = clearingYesPriceBps;
        uint16 noCostPerLot = uint16(PRICE_BPS_MAX - clearingYesPriceBps);

        uint256[] memory eligibleYesIds = new uint256[](validCount);
        uint256[] memory eligibleNoIds = new uint256[](validCount);
        uint256 yesN = 0;
        uint256 noN = 0;

        // Pass 2: apply limit checks at clearing price (ineligible orders refunded), and split by side.
        for (uint256 i = 0; i < orderIds.length; i++) {
            uint256 orderId = orderIds[i];
            OrderEnvelope storage order = orders[orderId];
            if (order.marketId != market.id || order.processed) continue;

            uint16 costPerLot = order.side == Side.YES ? yesCostPerLot : noCostPerLot;
            if (order.limitPriceBps < costPerLot) {
                rejectedCount++;
                _rejectOrderFullRefund(market, batch, order, orderId, ReasonCode.LIMIT_NOT_MET);
                continue;
            }

            if (order.side == Side.YES) {
                eligibleYesIds[yesN++] = orderId;
            } else {
                eligibleNoIds[noN++] = orderId;
            }
        }

        uint256 yesLots = _sumPossibleLots(eligibleYesIds, yesN, yesCostPerLot);
        uint256 noLots = _sumPossibleLots(eligibleNoIds, noN, noCostPerLot);
        matchedLots = yesLots < noLots ? yesLots : noLots;
        market.matchedLots = matchedLots;

        // If nothing matches, refund all eligible orders as UNMATCHED.
        if (matchedLots == 0) {
            for (uint256 i = 0; i < yesN; i++) {
                _refundUnmatchedById(market, batch, eligibleYesIds[i]);
            }
            for (uint256 i = 0; i < noN; i++) {
                _refundUnmatchedById(market, batch, eligibleNoIds[i]);
            }
            return (0, rejectedCount, clearingYesPriceBps, 0);
        }

        _sortOrderIdsByLimitDesc(eligibleYesIds, yesN);
        _sortOrderIdsByLimitDesc(eligibleNoIds, noN);

        if (yesLots <= noLots) {
            // YES is limiting: fill all eligible YES, then allocate NO up to matchedLots.
            for (uint256 i = 0; i < yesN; i++) {
                uint256 orderId = eligibleYesIds[i];
                uint256 possibleLots = orders[orderId].maxCost / uint256(yesCostPerLot);
                _fillOrderById(market, batch, orderId, yesCostPerLot, possibleLots, possibleLots);
                filledCount++;
            }

            uint256 remaining = matchedLots;
            for (uint256 i = 0; i < noN; i++) {
                uint256 orderId = eligibleNoIds[i];
                if (remaining == 0) {
                    _refundUnmatchedById(market, batch, orderId);
                    continue;
                }
                uint256 possibleLots = orders[orderId].maxCost / uint256(noCostPerLot);
                uint256 fillLots = possibleLots > remaining ? remaining : possibleLots;
                _fillOrderById(market, batch, orderId, noCostPerLot, possibleLots, fillLots);
                if (fillLots > 0) filledCount++;
                remaining -= fillLots;
            }
        } else {
            // NO is limiting: fill all eligible NO, then allocate YES up to matchedLots.
            for (uint256 i = 0; i < noN; i++) {
                uint256 orderId = eligibleNoIds[i];
                uint256 possibleLots = orders[orderId].maxCost / uint256(noCostPerLot);
                _fillOrderById(market, batch, orderId, noCostPerLot, possibleLots, possibleLots);
                filledCount++;
            }

            uint256 remaining = matchedLots;
            for (uint256 i = 0; i < yesN; i++) {
                uint256 orderId = eligibleYesIds[i];
                if (remaining == 0) {
                    _refundUnmatchedById(market, batch, orderId);
                    continue;
                }
                uint256 possibleLots = orders[orderId].maxCost / uint256(yesCostPerLot);
                uint256 fillLots = possibleLots > remaining ? remaining : possibleLots;
                _fillOrderById(market, batch, orderId, yesCostPerLot, possibleLots, fillLots);
                if (fillLots > 0) filledCount++;
                remaining -= fillLots;
            }
        }
    }

    function _rejectOrderFullRefund(
        MarketPolicy storage market,
        BatchRecord storage batch,
        OrderEnvelope storage order,
        uint256 orderId,
        ReasonCode reason
    ) internal {
        order.processed = true;
        order.state = OrderState.REJECTED;
        order.filledLots = 0;
        order.stake = 0;
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

    function _refundUnmatchedById(
        MarketPolicy storage market,
        BatchRecord storage batch,
        uint256 orderId
    ) internal {
        OrderEnvelope storage order = orders[orderId];
        order.processed = true;
        order.state = OrderState.REFUNDED;
        order.filledLots = 0;
        order.stake = 0;

        positions[market.id][order.trader].refundable += market.orderDepositUnit;

        emit OrderProcessed(market.id, orderId, order.trader, order.state, order.side, 0);
        _recordReceipt(
            market.id,
            orderId,
            order.trader,
            ReceiptStatus.FAILURE,
            ReasonCode.UNMATCHED,
            true,
            false,
            order.side,
            market.orderDepositUnit,
            batch.ordersRoot
        );
    }

    function _fillOrderById(
        MarketPolicy storage market,
        BatchRecord storage batch,
        uint256 orderId,
        uint16 costPerLot,
        uint256 possibleLots,
        uint256 fillLots
    ) internal {
        OrderEnvelope storage order = orders[orderId];
        order.processed = true;
        order.filledLots = fillLots;

        uint256 spentCost = fillLots * uint256(costPerLot);
        order.stake = spentCost;

        Position storage position = positions[market.id][order.trader];
        if (order.side == Side.YES) {
            position.yesLots += fillLots;
            market.totalYesStake += spentCost;
        } else {
            position.noLots += fillLots;
            market.totalNoStake += spentCost;
        }

        uint256 refund = market.orderDepositUnit - spentCost;
        if (refund > 0) {
            position.refundable += refund;
        }

        if (fillLots == 0) {
            order.state = OrderState.REFUNDED;
            emit OrderProcessed(market.id, orderId, order.trader, order.state, order.side, 0);
            _recordReceipt(
                market.id,
                orderId,
                order.trader,
                ReceiptStatus.FAILURE,
                ReasonCode.UNMATCHED,
                true,
                false,
                order.side,
                market.orderDepositUnit,
                batch.ordersRoot
            );
            return;
        }

        if (fillLots < possibleLots) {
            order.state = OrderState.PARTIALLY_FILLED;
        } else {
            order.state = OrderState.FILLED;
        }

        emit OrderProcessed(market.id, orderId, order.trader, order.state, order.side, spentCost);
        _recordReceipt(
            market.id,
            orderId,
            order.trader,
            ReceiptStatus.SUCCESS,
            fillLots < possibleLots ? ReasonCode.PARTIAL_FILL : ReasonCode.NONE,
            true,
            true,
            order.side,
            spentCost,
            batch.ordersRoot
        );
    }

    function _sumPossibleLots(
        uint256[] memory ids,
        uint256 count,
        uint16 costPerLot
    ) internal view returns (uint256 lots) {
        for (uint256 i = 0; i < count; i++) {
            OrderEnvelope storage order = orders[ids[i]];
            lots += order.maxCost / uint256(costPerLot);
        }
    }

    function _selectClearingPriceFromOrders(
        uint256[] memory orderIds,
        uint256 marketId
    ) internal view returns (uint16 clearingYesPriceBps, uint256 matchedLots) {
        uint16 low = PRICE_BPS_MIN;
        uint16 high = uint16(PRICE_BPS_MAX - 1);
        uint16 crossing = 5000;

        while (uint256(low) <= uint256(high)) {
            uint16 mid = uint16((uint256(low) + uint256(high)) / 2);
            (uint256 yesLots, uint256 noLots) = _lotsAtPriceFromOrders(orderIds, marketId, mid);
            if (yesLots > noLots) {
                low = uint16(mid + 1);
            } else {
                crossing = mid;
                high = mid > 0 ? uint16(mid - 1) : 0;
            }
        }

        (uint256 yes0, uint256 no0) = _lotsAtPriceFromOrders(orderIds, marketId, crossing);
        uint256 m0 = yes0 < no0 ? yes0 : no0;

        uint16 neighbor = crossing > PRICE_BPS_MIN ? uint16(crossing - 1) : crossing;
        (uint256 yes1, uint256 no1) = _lotsAtPriceFromOrders(orderIds, marketId, neighbor);
        uint256 m1 = yes1 < no1 ? yes1 : no1;

        if (m1 > m0) return (neighbor, m1);
        if (m1 == m0) {
            uint256 d0 = yes0 > no0 ? yes0 - no0 : no0 - yes0;
            uint256 d1 = yes1 > no1 ? yes1 - no1 : no1 - yes1;
            if (d1 < d0) return (neighbor, m1);
        }
        return (crossing, m0);
    }

    function _lotsAtPriceFromOrders(
        uint256[] memory orderIds,
        uint256 marketId,
        uint16 yesPriceBps
    ) internal view returns (uint256 yesLots, uint256 noLots) {
        uint16 noPriceBps = uint16(PRICE_BPS_MAX - yesPriceBps);
        for (uint256 i = 0; i < orderIds.length; i++) {
            OrderEnvelope storage order = orders[orderIds[i]];
            if (order.marketId != marketId || order.processed) continue;
            if (order.side == Side.YES) {
                if (order.limitPriceBps >= yesPriceBps) {
                    yesLots += order.maxCost / uint256(yesPriceBps);
                }
            } else if (order.side == Side.NO) {
                if (order.limitPriceBps >= noPriceBps) {
                    noLots += order.maxCost / uint256(noPriceBps);
                }
            }
        }
    }

    function _sortOrderIdsByLimitDesc(uint256[] memory ids, uint256 count) internal view {
        for (uint256 i = 1; i < count; i++) {
            uint256 key = ids[i];
            uint16 keyLimit = orders[key].limitPriceBps;
            uint256 j = i;
            while (j > 0) {
                uint256 prevId = ids[j - 1];
                uint16 prevLimit = orders[prevId].limitPriceBps;
                bool shouldSwap = prevLimit < keyLimit || (prevLimit == keyLimit && prevId > key);
                if (!shouldSwap) break;
                ids[j] = prevId;
                j--;
            }
            ids[j] = key;
        }
    }

    function _onDecryptOrderBatch(bytes[] calldata decryptedArguments, bytes[] calldata plaintextArguments) internal {
        if (plaintextArguments.length < 6) revert InvalidOrder();
        uint256 marketId = abi.decode(plaintextArguments[1], (uint256));
        uint256 batchId = abi.decode(plaintextArguments[2], (uint256));
        bytes32 ordersRoot = abi.decode(plaintextArguments[3], (bytes32));
        uint64 expiry = abi.decode(plaintextArguments[4], (uint64));
        uint256[] memory orderIds = abi.decode(plaintextArguments[5], (uint256[]));

        MarketPolicy storage market = markets[marketId];
        BatchRecord storage batch = batches[batchId];

        if (market.id == 0 || batch.id == 0) revert InvalidMarket();
        if (batch.marketId != marketId || market.activeBatchId != batchId) revert InvalidOrder();
        if (msg.sender != batch.ctxSender) revert Unauthorized();
        if (market.state != MarketState.ORDER_CTX_REQUESTED) revert InvalidState();
        if (ordersRoot != batch.ordersRoot || expiry != batch.expiry) revert InvalidOrder();
        if (decryptedArguments.length != orderIds.length) revert InvalidOrder();

        (uint256 filledCount, uint256 rejectedCount, uint16 clearingYesPriceBps, uint256 matchedLots) = _processBatchOrders(
            market,
            batch,
            orderIds,
            decryptedArguments
        );

        market.state = MarketState.BATCH_PROCESSED;
        emit BatchProcessed(market.id, batch.id, filledCount, rejectedCount, clearingYesPriceBps, matchedLots, ordersRoot);
        _recordReceipt(market.id, 0, address(0), ReceiptStatus.SUCCESS, ReasonCode.NONE, true, true, Side.NONE, 0, ordersRoot);
    }

    function _onDecryptOutcome(bytes[] calldata decryptedArguments, bytes[] calldata plaintextArguments) internal {
        if (plaintextArguments.length < 4) revert InvalidOrder();
        if (decryptedArguments.length != 1) revert InvalidOrder();

        uint256 marketId = abi.decode(plaintextArguments[1], (uint256));
        uint64 expiry = abi.decode(plaintextArguments[2], (uint64));
        bytes32 commitmentHash = abi.decode(plaintextArguments[3], (bytes32));

        MarketPolicy storage market = markets[marketId];
        if (market.id == 0) revert InvalidMarket();
        if (market.state != MarketState.OUTCOME_CTX_REQUESTED) revert InvalidState();
        if (market.outcomeCommitmentHash != commitmentHash) revert InvalidOrder();
        if (msg.sender != market.outcomeCtxSender) revert Unauthorized();

        if (keccak256(decryptedArguments[0]) != market.outcomeCommitmentHash) {
            revert InvalidOrder();
        }

        DecryptedOutcome memory d = abi.decode(decryptedArguments[0], (DecryptedOutcome));
        if (d.marketId != marketId) revert InvalidOrder();
        if (d.outcome > uint8(Outcome.INVALID) || d.outcome == uint8(Outcome.UNRESOLVED)) revert InvalidOrder();

        market.proposedOutcome = Outcome(d.outcome);
        market.state = MarketState.RESOLUTION_PROPOSED;
        market.disputeDeadline = uint64(block.timestamp + market.disputeWindowSeconds);
        market.outcomeEvidenceHash = d.evidenceHash;

        emit ResolutionProposed(marketId, market.proposedOutcome, market.disputeDeadline, d.evidenceHash);
        _recordReceipt(marketId, 0, msg.sender, ReceiptStatus.PENDING, ReasonCode.NONE, true, false, Side.NONE, 0, d.evidenceHash);

        // `expiry` is part of the attestation domain; it's intentionally not a runtime constraint for the callback.
        expiry;
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
