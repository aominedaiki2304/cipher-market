// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BitePrecompile} from "./libraries/BitePrecompile.sol";
import {IBiteSupplicant} from "./interfaces/IBiteSupplicant.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";

contract PrivateProcurement is IBiteSupplicant {
    uint256 public constant CTX_GAS_LIMIT = 2_500_000;

    enum IntentState {
        CREATED,
        CTX_REQUESTED,
        PENDING_APPROVAL,
        EXECUTED,
        FAILED
    }

    enum ReceiptStatus {
        SUCCESS,
        FAILURE,
        PENDING_APPROVAL
    }

    enum ReasonCode {
        NONE,
        INVALID_ATTESTATION,
        EXPIRED_ATTESTATION,
        QUOTE_MISMATCH,
        SUPPLIER_NOT_ALLOWLISTED,
        OVER_SPEND_CAP,
        INSUFFICIENT_BUDGET,
        MANUAL_APPROVAL_REQUIRED,
        ERC20_TRANSFER_FAILED,
        EXECUTED,
        APPROVED_EXECUTION
    }

    struct Policy {
        uint256 id;
        address buyer;
        address paymentToken;
        uint256 budget;
        uint256 remainingBudget;
        uint256 spendCapPerIntent;
        address[] allowlistedSuppliers;
        address attestor;
        address approver;
        uint256 manualApprovalThreshold;
        bool active;
    }

    struct Intent {
        uint256 id;
        uint256 policyId;
        address creator;
        bytes encryptedPayload;
        bytes32 commitmentHash;
        IntentState state;
        uint256 createdAt;
        address ctxSender;
        bytes32 triggerTxHash;
        bytes32 pendingQuoteHash;
        bytes32 pendingMetadataHash;
        address pendingSupplier;
        uint256 pendingAmount;
        uint256 lastReceiptId;
    }

    struct Receipt {
        uint256 receiptId;
        uint256 intentId;
        uint256 policyId;
        ReceiptStatus status;
        ReasonCode reasonCode;
        bool conditionPassed;
        bool executed;
        address supplier;
        uint256 amount;
        address token;
        bytes32 quoteHash;
        bytes32 metadataHash;
        uint256 timestamp;
    }

    struct AttestationPayload {
        bytes32 deliveryProofHash;
        bytes32 quoteHash;
        uint64 expiry;
    }

    struct DecryptedIntent {
        address supplier;
        uint256 amount;
        bytes32 quoteHash;
        bytes32 metadataHash;
        uint256 nonce;
    }

    uint256 public nextPolicyId = 1;
    uint256 public nextIntentId = 1;
    uint256 public nextReceiptId = 1;

    mapping(uint256 => Policy) internal policies;
    mapping(uint256 => mapping(address => bool)) public policySupplierAllowed;
    mapping(uint256 => Intent) internal intents;
    mapping(uint256 => Receipt) internal receipts;

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed buyer,
        address indexed paymentToken,
        uint256 budget,
        uint256 spendCapPerIntent,
        uint256 manualApprovalThreshold,
        address attestor,
        address approver
    );
    event PolicyFunded(uint256 indexed policyId, uint256 amount, uint256 remainingBudget);
    event IntentCreated(
        uint256 indexed intentId,
        uint256 indexed policyId,
        address indexed creator,
        bytes32 commitmentHash
    );
    event IntentTriggered(uint256 indexed intentId, uint256 indexed policyId, address indexed triggerer);
    event IntentStateChanged(uint256 indexed intentId, IntentState newState);
    event ReceiptRecorded(
        uint256 indexed receiptId,
        uint256 indexed intentId,
        uint256 indexed policyId,
        ReceiptStatus status,
        ReasonCode reasonCode,
        bool conditionPassed,
        bool executed,
        address supplier,
        uint256 amount
    );

    error InvalidPolicy();
    error InvalidIntent();
    error Unauthorized();
    error InvalidSignature();
    error InvalidState();
    error InsufficientFunding();

    receive() external payable {}

    function createPolicy(
        address paymentToken,
        uint256 budget,
        uint256 spendCapPerIntent,
        address[] calldata allowlistedSuppliers,
        address attestor,
        address approver,
        uint256 manualApprovalThreshold
    ) external returns (uint256 policyId) {
        if (paymentToken == address(0) || attestor == address(0) || approver == address(0)) {
            revert InvalidPolicy();
        }
        if (budget == 0 || spendCapPerIntent == 0 || manualApprovalThreshold == 0) {
            revert InvalidPolicy();
        }
        if (allowlistedSuppliers.length == 0) {
            revert InvalidPolicy();
        }

        policyId = nextPolicyId++;
        Policy storage policy = policies[policyId];
        policy.id = policyId;
        policy.buyer = msg.sender;
        policy.paymentToken = paymentToken;
        policy.budget = budget;
        policy.remainingBudget = 0;
        policy.spendCapPerIntent = spendCapPerIntent;
        policy.attestor = attestor;
        policy.approver = approver;
        policy.manualApprovalThreshold = manualApprovalThreshold;
        policy.active = true;

        for (uint256 i = 0; i < allowlistedSuppliers.length; i++) {
            address supplier = allowlistedSuppliers[i];
            if (supplier == address(0) || policySupplierAllowed[policyId][supplier]) {
                revert InvalidPolicy();
            }
            policySupplierAllowed[policyId][supplier] = true;
            policy.allowlistedSuppliers.push(supplier);
        }

        emit PolicyCreated(
            policyId,
            msg.sender,
            paymentToken,
            budget,
            spendCapPerIntent,
            manualApprovalThreshold,
            attestor,
            approver
        );
    }

    function fundPolicy(uint256 policyId, uint256 amount) external {
        Policy storage policy = policies[policyId];
        if (policy.id == 0) revert InvalidPolicy();
        if (msg.sender != policy.buyer) revert Unauthorized();
        if (amount == 0) revert InvalidPolicy();
        if (policy.remainingBudget + amount > policy.budget) revert InsufficientFunding();

        bool ok = IERC20Minimal(policy.paymentToken).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert InsufficientFunding();

        policy.remainingBudget += amount;
        emit PolicyFunded(policyId, amount, policy.remainingBudget);
    }

    function createEncryptedIntent(
        uint256 policyId,
        bytes calldata encryptedPayload,
        bytes32 commitmentHash
    ) external returns (uint256 intentId) {
        Policy storage policy = policies[policyId];
        if (policy.id == 0 || !policy.active) revert InvalidPolicy();
        if (msg.sender != policy.buyer) revert Unauthorized();
        if (encryptedPayload.length == 0 || commitmentHash == bytes32(0)) revert InvalidIntent();

        intentId = nextIntentId++;
        intents[intentId] = Intent({
            id: intentId,
            policyId: policyId,
            creator: msg.sender,
            encryptedPayload: encryptedPayload,
            commitmentHash: commitmentHash,
            state: IntentState.CREATED,
            createdAt: block.timestamp,
            ctxSender: address(0),
            triggerTxHash: bytes32(0),
            pendingQuoteHash: bytes32(0),
            pendingMetadataHash: bytes32(0),
            pendingSupplier: address(0),
            pendingAmount: 0,
            lastReceiptId: 0
        });

        emit IntentCreated(intentId, policyId, msg.sender, commitmentHash);
        emit IntentStateChanged(intentId, IntentState.CREATED);
    }

    function triggerIntent(
        uint256 intentId,
        AttestationPayload calldata payload,
        bytes calldata attestationSignature
    ) external payable {
        Intent storage intent = intents[intentId];
        if (intent.id == 0) revert InvalidIntent();
        if (intent.state != IntentState.CREATED) revert InvalidState();

        Policy storage policy = policies[intent.policyId];
        if (policy.id == 0 || !policy.active) revert InvalidPolicy();
        if (payload.expiry <= block.timestamp) revert InvalidSignature();

        intent.state = IntentState.CTX_REQUESTED;
        emit IntentStateChanged(intentId, IntentState.CTX_REQUESTED);

        bytes[] memory encryptedArgs = new bytes[](1);
        encryptedArgs[0] = intent.encryptedPayload;

        bytes[] memory plaintextArgs = new bytes[](5);
        plaintextArgs[0] = abi.encode(intentId);
        plaintextArgs[1] = abi.encode(payload.deliveryProofHash);
        plaintextArgs[2] = abi.encode(payload.quoteHash);
        plaintextArgs[3] = abi.encode(payload.expiry);
        plaintextArgs[4] = attestationSignature;

        uint256 gasUnits = CTX_GAS_LIMIT;
        if (msg.value > 0 && tx.gasprice > 0) {
            gasUnits = msg.value / tx.gasprice;
        }

        address ctxSender = BitePrecompile.submitCTX(gasUnits, encryptedArgs, plaintextArgs);

        intent.ctxSender = ctxSender;
        intent.triggerTxHash = keccak256(
            abi.encodePacked(blockhash(block.number - 1), intentId, msg.sender, block.timestamp)
        );

        if (msg.value > 0) {
            (bool sent, ) = payable(ctxSender).call{value: msg.value}("");
            require(sent, "CTX gas transfer failed");
        }

        emit IntentTriggered(intentId, intent.policyId, msg.sender);
    }

    function onDecrypt(
        bytes[] calldata decryptedArguments,
        bytes[] calldata plaintextArguments
    ) external override {
        if (decryptedArguments.length == 0 || plaintextArguments.length < 5) revert InvalidIntent();

        uint256 intentId = abi.decode(plaintextArguments[0], (uint256));
        bytes32 deliveryProofHash = abi.decode(plaintextArguments[1], (bytes32));
        bytes32 quoteHash = abi.decode(plaintextArguments[2], (bytes32));
        uint64 expiry = abi.decode(plaintextArguments[3], (uint64));
        bytes memory attestationSignature = plaintextArguments[4];

        Intent storage intent = intents[intentId];
        if (intent.id == 0 || intent.state != IntentState.CTX_REQUESTED) revert InvalidIntent();
        if (msg.sender != intent.ctxSender) revert Unauthorized();

        DecryptedIntent memory decoded = abi.decode(decryptedArguments[0], (DecryptedIntent));
        Policy storage policy = policies[intent.policyId];

        ReasonCode failureReason = _validateDecryptedIntent(
            policy,
            intentId,
            decoded,
            quoteHash,
            deliveryProofHash,
            expiry,
            attestationSignature
        );

        if (failureReason != ReasonCode.NONE) {
            _recordFailure(intent, policy, decoded, failureReason);
            return;
        }

        if (decoded.amount > policy.manualApprovalThreshold) {
            intent.state = IntentState.PENDING_APPROVAL;
            intent.pendingSupplier = decoded.supplier;
            intent.pendingAmount = decoded.amount;
            intent.pendingQuoteHash = decoded.quoteHash;
            intent.pendingMetadataHash = decoded.metadataHash;

            emit IntentStateChanged(intent.id, IntentState.PENDING_APPROVAL);
            _recordReceipt(
                intent,
                policy,
                ReceiptStatus.PENDING_APPROVAL,
                ReasonCode.MANUAL_APPROVAL_REQUIRED,
                true,
                false,
                decoded.supplier,
                decoded.amount,
                decoded.quoteHash,
                decoded.metadataHash
            );
            return;
        }

        _executeTransfer(intent, policy, decoded.supplier, decoded.amount, decoded.quoteHash, decoded.metadataHash, false);
    }

    function approveAndExecute(uint256 intentId) external {
        Intent storage intent = intents[intentId];
        if (intent.id == 0 || intent.state != IntentState.PENDING_APPROVAL) revert InvalidState();

        Policy storage policy = policies[intent.policyId];
        if (msg.sender != policy.approver) revert Unauthorized();

        _executeTransfer(
            intent,
            policy,
            intent.pendingSupplier,
            intent.pendingAmount,
            intent.pendingQuoteHash,
            intent.pendingMetadataHash,
            true
        );
    }

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }

    function getPolicyAllowlist(uint256 policyId) external view returns (address[] memory) {
        return policies[policyId].allowlistedSuppliers;
    }

    function getIntent(uint256 intentId) external view returns (Intent memory) {
        return intents[intentId];
    }

    function getReceipt(uint256 receiptId) external view returns (Receipt memory) {
        return receipts[receiptId];
    }

    function _validateDecryptedIntent(
        Policy storage policy,
        uint256 intentId,
        DecryptedIntent memory decoded,
        bytes32 quoteHash,
        bytes32 deliveryProofHash,
        uint64 expiry,
        bytes memory signature
    ) internal view returns (ReasonCode) {
        bytes32 digest = keccak256(
            abi.encode(address(this), intentId, deliveryProofHash, quoteHash, expiry)
        );

        address recovered = _recoverSigner(digest, signature);
        if (recovered != policy.attestor) return ReasonCode.INVALID_ATTESTATION;
        if (block.timestamp > expiry) return ReasonCode.EXPIRED_ATTESTATION;
        if (decoded.quoteHash != quoteHash) return ReasonCode.QUOTE_MISMATCH;
        if (!policySupplierAllowed[policy.id][decoded.supplier]) return ReasonCode.SUPPLIER_NOT_ALLOWLISTED;
        if (decoded.amount > policy.spendCapPerIntent) return ReasonCode.OVER_SPEND_CAP;
        if (decoded.amount > policy.remainingBudget) return ReasonCode.INSUFFICIENT_BUDGET;

        return ReasonCode.NONE;
    }

    function _executeTransfer(
        Intent storage intent,
        Policy storage policy,
        address supplier,
        uint256 amount,
        bytes32 quoteHash,
        bytes32 metadataHash,
        bool approvedPath
    ) internal {
        bool ok = IERC20Minimal(policy.paymentToken).transfer(supplier, amount);
        if (!ok) {
            _recordFailure(
                intent,
                policy,
                DecryptedIntent(supplier, amount, quoteHash, metadataHash, 0),
                ReasonCode.ERC20_TRANSFER_FAILED
            );
            return;
        }

        policy.remainingBudget -= amount;
        intent.state = IntentState.EXECUTED;
        emit IntentStateChanged(intent.id, IntentState.EXECUTED);

        _recordReceipt(
            intent,
            policy,
            ReceiptStatus.SUCCESS,
            approvedPath ? ReasonCode.APPROVED_EXECUTION : ReasonCode.EXECUTED,
            true,
            true,
            supplier,
            amount,
            quoteHash,
            metadataHash
        );
    }

    function _recordFailure(
        Intent storage intent,
        Policy storage policy,
        DecryptedIntent memory decoded,
        ReasonCode reason
    ) internal {
        intent.state = IntentState.FAILED;
        emit IntentStateChanged(intent.id, IntentState.FAILED);

        _recordReceipt(
            intent,
            policy,
            ReceiptStatus.FAILURE,
            reason,
            false,
            false,
            decoded.supplier,
            decoded.amount,
            decoded.quoteHash,
            decoded.metadataHash
        );
    }

    function _recordReceipt(
        Intent storage intent,
        Policy storage policy,
        ReceiptStatus status,
        ReasonCode reason,
        bool conditionPassed,
        bool executed,
        address supplier,
        uint256 amount,
        bytes32 quoteHash,
        bytes32 metadataHash
    ) internal {
        uint256 receiptId = nextReceiptId++;
        receipts[receiptId] = Receipt({
            receiptId: receiptId,
            intentId: intent.id,
            policyId: policy.id,
            status: status,
            reasonCode: reason,
            conditionPassed: conditionPassed,
            executed: executed,
            supplier: supplier,
            amount: amount,
            token: policy.paymentToken,
            quoteHash: quoteHash,
            metadataHash: metadataHash,
            timestamp: block.timestamp
        });

        intent.lastReceiptId = receiptId;

        emit ReceiptRecorded(
            receiptId,
            intent.id,
            policy.id,
            status,
            reason,
            conditionPassed,
            executed,
            supplier,
            amount
        );
    }

    function _recoverSigner(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);

        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );

        return ecrecover(ethSignedMessageHash, v, r, s);
    }
}
