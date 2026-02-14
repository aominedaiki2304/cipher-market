import assert from "node:assert/strict";
import test from "node:test";
import {
  validateBatchTriggerInput,
  validateEncryptOrderInput,
  validateResolutionInput
} from "../src/app.js";
import { normalizeReceipt } from "../src/receipt.js";

test("validateEncryptOrderInput rejects invalid trader", () => {
  const result = validateEncryptOrderInput({
    trader: "not-an-address",
    side: 1,
    stake: "1000000",
    nonce: 0
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_TRADER");
  assert.equal(result.status, 400);
});

test("validateBatchTriggerInput rejects invalid chainId", () => {
  const result = validateBatchTriggerInput(
    {
      marketId: 1,
      batchId: 1,
      ordersRoot: `0x${"2".repeat(64)}`,
      expiry: Math.floor(Date.now() / 1000) + 1800
    },
    {
      contractAddress: "0x1111111111111111111111111111111111111111",
      chainId: 0
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_CHAIN_ID");
  assert.equal(result.status, 400);
});

test("validateResolutionInput rejects invalid evidenceHash", () => {
  const result = validateResolutionInput(
    {
      marketId: 1,
      outcome: 1,
      evidenceHash: "0x1234",
      expiry: Math.floor(Date.now() / 1000) + 1800
    },
    {
      contractAddress: "0x1111111111111111111111111111111111111111",
      chainId: 103698795
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_EVIDENCE_HASH");
  assert.equal(result.status, 400);
});

test("normalizeReceipt returns canonical schema with trader/actor parity", () => {
  const normalized = normalizeReceipt({
    receiptId: 9,
    marketId: 4,
    orderId: 7,
    actor: "0x1111111111111111111111111111111111111111",
    status: "SUCCESS",
    reasonCode: "NONE",
    conditionPassed: true,
    executed: true,
    side: "YES",
    amount: "1000000",
    evidenceHash: `0x${"4".repeat(64)}`
  });

  assert.equal(normalized.receiptId, 9);
  assert.equal(normalized.marketId, 4);
  assert.equal(normalized.orderId, 7);
  assert.equal(normalized.trader, "0x1111111111111111111111111111111111111111");
  assert.equal(normalized.actor, normalized.trader);
  assert.equal(typeof normalized.evidence, "object");
  assert.equal(normalized.evidenceHash, `0x${"4".repeat(64)}`);
});
