// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PrivateProcurement.sol";
import "../src/mocks/MockUSDC.sol";

contract PrivateProcurementHarness is PrivateProcurement {
    function setCtxRequested(uint256 intentId, address ctxSender) external {
        intents[intentId].ctxSender = ctxSender;
        intents[intentId].state = IntentState.CTX_REQUESTED;
    }
}

contract PrivateProcurementTest is Test {
    MockUSDC internal token;
    PrivateProcurementHarness internal app;

    address internal buyer = makeAddr("buyer");
    address internal approver = makeAddr("approver");
    address internal supplier = makeAddr("supplier");

    uint256 internal attestorPk = 0xA11CE;
    address internal attestor;

    function setUp() external {
        attestor = vm.addr(attestorPk);

        token = new MockUSDC();
        app = new PrivateProcurementHarness();

        token.mint(buyer, 500_000_000);
    }

    function testCreateAndFundPolicy() external {
        address[] memory allowlist = new address[](1);
        allowlist[0] = supplier;

        vm.startPrank(buyer);
        uint256 policyId = app.createPolicy(
            address(token),
            200_000_000,
            100_000_000,
            allowlist,
            attestor,
            approver,
            75_000_000
        );

        token.approve(address(app), 200_000_000);
        app.fundPolicy(policyId, 150_000_000);
        vm.stopPrank();

        PrivateProcurement.Policy memory policy = app.getPolicy(policyId);
        assertEq(policy.remainingBudget, 150_000_000);
    }

    function testFailureReceiptOnInvalidAttestation() external {
        address[] memory allowlist = new address[](1);
        allowlist[0] = supplier;

        vm.startPrank(buyer);
        uint256 policyId = app.createPolicy(
            address(token),
            100_000_000,
            50_000_000,
            allowlist,
            attestor,
            approver,
            25_000_000
        );
        token.approve(address(app), 100_000_000);
        app.fundPolicy(policyId, 100_000_000);

        bytes memory encryptedPayload = hex"1234";
        uint256 intentId = app.createEncryptedIntent(policyId, encryptedPayload, keccak256("commit"));
        vm.stopPrank();

        address ctxSender = makeAddr("ctxSender");
        app.setCtxRequested(intentId, ctxSender);

        PrivateProcurement.DecryptedIntent memory d = PrivateProcurement.DecryptedIntent({
            supplier: supplier,
            amount: 10_000_000,
            quoteHash: keccak256("quote"),
            metadataHash: keccak256("meta"),
            nonce: 1
        });

        bytes[] memory decrypted = new bytes[](1);
        decrypted[0] = abi.encode(d);

        bytes[] memory plain = new bytes[](5);
        plain[0] = abi.encode(intentId);
        plain[1] = abi.encode(keccak256("delivery"));
        plain[2] = abi.encode(keccak256("quote"));
        plain[3] = abi.encode(uint64(block.timestamp + 1 hours));
        plain[4] = bytes("bad-signature");

        vm.prank(ctxSender);
        app.onDecrypt(decrypted, plain);

        PrivateProcurement.Intent memory intent = app.getIntent(intentId);
        assertEq(uint256(intent.state), uint256(PrivateProcurement.IntentState.FAILED));
    }
}
