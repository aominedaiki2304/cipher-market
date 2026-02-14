import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import { getAddress, isAddress } from "viem";
import { config } from "./config.js";
import { appendTrace, writeJsonTrace } from "./trace.js";
import { encryptOrderPayload } from "./crypto.js";
import {
  signBatchTriggerAttestation,
  signOutcomeRevealAttestation,
  signResolutionAttestation
} from "./attestation.js";
import { normalizeReceipt } from "./receipt.js";

const HASH32_REGEX = /^0x[0-9a-fA-F]{64}$/;

function sendError(res, status, error, code, details) {
  return res.status(status).json({
    error,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {})
  });
}

function toInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0 && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return NaN;
}

function isPositiveInteger(value) {
  const parsed = toInteger(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function validationFailure(status, error, code, details) {
  return {
    ok: false,
    status,
    error,
    code,
    ...(details !== undefined ? { details } : {})
  };
}

function validationSuccess(value) {
  return { ok: true, value };
}

export function validateEncryptOrderInput(input = {}) {
  const { trader, side = 1, stake = "0", limitPriceBps = 10000, nonce = 0 } = input;

  if (!trader || !isAddress(trader)) {
    return validationFailure(400, "trader is required and must be a valid address", "INVALID_TRADER");
  }
  if (![1, 2].includes(Number(side))) {
    return validationFailure(400, "side must be 1 (YES) or 2 (NO)", "INVALID_SIDE");
  }

  let stakeValue;
  try {
    stakeValue = BigInt(stake);
  } catch (_error) {
    return validationFailure(400, "stake must be an integer string", "INVALID_STAKE");
  }
  if (stakeValue <= 0n) {
    return validationFailure(400, "stake must be greater than zero", "INVALID_STAKE");
  }

  const nonceValue = toInteger(nonce);
  if (!Number.isInteger(nonceValue) || nonceValue < 0) {
    return validationFailure(400, "nonce must be a non-negative integer", "INVALID_NONCE");
  }

  const limitValue = toInteger(limitPriceBps);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 10000) {
    return validationFailure(
      400,
      "limitPriceBps must be an integer between 1 and 10000",
      "INVALID_LIMIT_PRICE"
    );
  }

  return validationSuccess({
    trader: getAddress(trader),
    side: Number(side),
    stake: String(stake),
    limitPriceBps: limitValue,
    nonce: nonceValue
  });
}

export function validateBatchTriggerInput(
  input = {},
  defaults = {
    contractAddress: config.defaultContractAddress,
    chainId: config.chainId
  }
) {
  const contractAddress = input.contractAddress ?? defaults.contractAddress;
  const chainId = input.chainId ?? defaults.chainId;
  const { marketId, batchId, ordersRoot, expiry } = input;

  if (!contractAddress || !isAddress(contractAddress)) {
    return validationFailure(400, "contractAddress is required and must be valid", "INVALID_CONTRACT");
  }
  if (!isPositiveInteger(chainId)) {
    return validationFailure(400, "chainId must be a positive integer", "INVALID_CHAIN_ID");
  }
  if (!isPositiveInteger(marketId)) {
    return validationFailure(400, "marketId must be a positive integer", "INVALID_MARKET_ID");
  }
  if (!isPositiveInteger(batchId)) {
    return validationFailure(400, "batchId must be a positive integer", "INVALID_BATCH_ID");
  }
  if (!HASH32_REGEX.test(String(ordersRoot || ""))) {
    return validationFailure(400, "ordersRoot must be a 32-byte hex string", "INVALID_ORDERS_ROOT");
  }
  if (!isPositiveInteger(expiry)) {
    return validationFailure(400, "expiry must be a positive unix timestamp", "INVALID_EXPIRY");
  }

  return validationSuccess({
    contractAddress: getAddress(contractAddress),
    chainId: Number(chainId),
    marketId: Number(marketId),
    batchId: Number(batchId),
    ordersRoot: String(ordersRoot),
    expiry: Number(expiry)
  });
}

export function validateResolutionInput(
  input = {},
  defaults = {
    contractAddress: config.defaultContractAddress,
    chainId: config.chainId
  }
) {
  const contractAddress = input.contractAddress ?? defaults.contractAddress;
  const chainId = input.chainId ?? defaults.chainId;
  const { marketId, outcome, evidenceHash, expiry } = input;

  if (!contractAddress || !isAddress(contractAddress)) {
    return validationFailure(400, "contractAddress is required and must be valid", "INVALID_CONTRACT");
  }
  if (!isPositiveInteger(chainId)) {
    return validationFailure(400, "chainId must be a positive integer", "INVALID_CHAIN_ID");
  }
  if (!isPositiveInteger(marketId)) {
    return validationFailure(400, "marketId must be a positive integer", "INVALID_MARKET_ID");
  }
  if (![1, 2, 3].includes(Number(outcome))) {
    return validationFailure(400, "outcome must be 1 (YES), 2 (NO), or 3 (INVALID)", "INVALID_OUTCOME");
  }
  if (!HASH32_REGEX.test(String(evidenceHash || ""))) {
    return validationFailure(400, "evidenceHash must be a 32-byte hex string", "INVALID_EVIDENCE_HASH");
  }
  if (!isPositiveInteger(expiry)) {
    return validationFailure(400, "expiry must be a positive unix timestamp", "INVALID_EXPIRY");
  }

  return validationSuccess({
    contractAddress: getAddress(contractAddress),
    chainId: Number(chainId),
    marketId: Number(marketId),
    outcome: Number(outcome),
    evidenceHash: String(evidenceHash),
    expiry: Number(expiry)
  });
}

export function validateOutcomeRevealInput(
  input = {},
  defaults = {
    contractAddress: config.defaultContractAddress,
    chainId: config.chainId
  }
) {
  const contractAddress = input.contractAddress ?? defaults.contractAddress;
  const chainId = input.chainId ?? defaults.chainId;
  const { marketId, commitmentHash, expiry } = input;

  if (!contractAddress || !isAddress(contractAddress)) {
    return validationFailure(400, "contractAddress is required and must be valid", "INVALID_CONTRACT");
  }
  if (!isPositiveInteger(chainId)) {
    return validationFailure(400, "chainId must be a positive integer", "INVALID_CHAIN_ID");
  }
  if (!isPositiveInteger(marketId)) {
    return validationFailure(400, "marketId must be a positive integer", "INVALID_MARKET_ID");
  }
  if (!HASH32_REGEX.test(String(commitmentHash || ""))) {
    return validationFailure(400, "commitmentHash must be a 32-byte hex string", "INVALID_COMMITMENT_HASH");
  }
  if (!isPositiveInteger(expiry)) {
    return validationFailure(400, "expiry must be a positive unix timestamp", "INVALID_EXPIRY");
  }

  return validationSuccess({
    contractAddress: getAddress(contractAddress),
    chainId: Number(chainId),
    marketId: Number(marketId),
    commitmentHash: String(commitmentHash),
    expiry: Number(expiry)
  });
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/relayer/markets", (_req, res) => {
    const limitRaw = _req.query?.limit;
    const limit = Math.max(
      1,
      Math.min(200, typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : 50)
    );

    const tracePath = path.join(config.rootDir, "artifacts", "traces", "full-flow.jsonl");
    if (!fs.existsSync(tracePath)) {
      return res.json({ markets: [], generatedAt: new Date().toISOString() });
    }

    const text = fs.readFileSync(tracePath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const byMarketId = new Map();

    for (let i = lines.length - 1; i >= 0; i--) {
      if (byMarketId.size >= limit) break;
      try {
        const row = JSON.parse(lines[i]);
        if (row?.eventType !== "relayer_market_created") continue;
        const payload = row?.payload || {};
        const marketId = Number(payload.marketId);
        if (!Number.isFinite(marketId) || marketId <= 0) continue;
        if (byMarketId.has(marketId)) continue;

        const question = String(payload.question || "");
        const cleaned = question.replace(/\s*\[demo.*\]\s*$/i, "").trim();

        byMarketId.set(marketId, {
          marketId,
          title: cleaned || question || `Market #${marketId}`,
          question,
          openTime: Number(payload.openTime || 0),
          closeTime: Number(payload.closeTime || 0),
          resolveBy: Number(payload.resolveBy || 0),
          txHash: payload.txHash || null
        });
      } catch (_error) {
        // ignore bad lines
      }
    }

    const markets = Array.from(byMarketId.values()).sort((a, b) => b.marketId - a.marketId);
    res.json({ markets, generatedAt: new Date().toISOString() });
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "private-prediction-market-api",
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      contractAddress: config.defaultContractAddress,
      attestorAddress: config.attestorAddress,
      relayerAddress: config.relayerAddress,
      relayerEnabled: Boolean(config.relayerAddress)
    });
  });

  app.post("/api/encrypt-order", async (req, res) => {
    try {
      const validation = validateEncryptOrderInput(req.body);
      if (!validation.ok) {
        return sendError(
          res,
          validation.status,
          validation.error,
          validation.code,
          validation.details
        );
      }

      const result = await encryptOrderPayload(validation.value);

      appendTrace("order_encrypted", {
        trader: validation.value.trader,
        side: validation.value.side,
        stake: validation.value.stake,
        limitPriceBps: validation.value.limitPriceBps,
        mode: result.mode,
        commitmentHash: result.commitmentHash,
        encryptionError: result.encryptionError
      });

      return res.json(result);
    } catch (error) {
      return sendError(
        res,
        500,
        error instanceof Error ? error.message : "Failed to encrypt order",
        "ENCRYPT_ORDER_FAILED"
      );
    }
  });

  app.post("/api/attest-batch-trigger", async (req, res) => {
    try {
      const validation = validateBatchTriggerInput(req.body);
      if (!validation.ok) {
        return sendError(
          res,
          validation.status,
          validation.error,
          validation.code,
          validation.details
        );
      }

      const signed = await signBatchTriggerAttestation(validation.value);

      appendTrace("ctx_batch_triggered", {
        contractAddress: validation.value.contractAddress,
        chainId: validation.value.chainId,
        marketId: validation.value.marketId,
        batchId: validation.value.batchId,
        ordersRoot: validation.value.ordersRoot,
        digest: signed.digest,
        attestorAddress: signed.attestorAddress
      });

      return res.json({
        ...validation.value,
        digest: signed.digest,
        attestorAddress: signed.attestorAddress,
        recoveredAddress: signed.recoveredAddress,
        signature: signed.signature
      });
    } catch (error) {
      return sendError(
        res,
        500,
        error instanceof Error ? error.message : "Failed to sign batch trigger attestation",
        "ATTEST_BATCH_FAILED"
      );
    }
  });

  app.post("/api/attest-resolution", async (req, res) => {
    try {
      const validation = validateResolutionInput(req.body);
      if (!validation.ok) {
        return sendError(
          res,
          validation.status,
          validation.error,
          validation.code,
          validation.details
        );
      }

      const signed = await signResolutionAttestation(validation.value);

      appendTrace("resolution_attested", {
        contractAddress: validation.value.contractAddress,
        chainId: validation.value.chainId,
        marketId: validation.value.marketId,
        outcome: validation.value.outcome,
        evidenceHash: validation.value.evidenceHash,
        digest: signed.digest,
        attestorAddress: signed.attestorAddress
      });

      return res.json({
        ...validation.value,
        digest: signed.digest,
        attestorAddress: signed.attestorAddress,
        recoveredAddress: signed.recoveredAddress,
        signature: signed.signature
      });
    } catch (error) {
      return sendError(
        res,
        500,
        error instanceof Error ? error.message : "Failed to sign resolution attestation",
        "ATTEST_RESOLUTION_FAILED"
      );
    }
  });

  app.post("/api/attest-outcome-reveal", async (req, res) => {
    try {
      const validation = validateOutcomeRevealInput(req.body);
      if (!validation.ok) {
        return sendError(
          res,
          validation.status,
          validation.error,
          validation.code,
          validation.details
        );
      }

      const signed = await signOutcomeRevealAttestation(validation.value);

      appendTrace("outcome_reveal_attested", {
        contractAddress: validation.value.contractAddress,
        chainId: validation.value.chainId,
        marketId: validation.value.marketId,
        commitmentHash: validation.value.commitmentHash,
        digest: signed.digest,
        attestorAddress: signed.attestorAddress
      });

      return res.json({
        ...validation.value,
        digest: signed.digest,
        attestorAddress: signed.attestorAddress,
        recoveredAddress: signed.recoveredAddress,
        signature: signed.signature
      });
    } catch (error) {
      return sendError(
        res,
        500,
        error instanceof Error ? error.message : "Failed to sign outcome reveal attestation",
        "ATTEST_OUTCOME_REVEAL_FAILED"
      );
    }
  });

  app.post("/api/normalize-receipt", (req, res) => {
    try {
      const normalized = normalizeReceipt(req.body);
      appendTrace("receipt_normalized", normalized);
      res.json(normalized);
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "Failed to normalize receipt",
        "NORMALIZE_RECEIPT_FAILED"
      );
    }
  });

  app.get("/api/demo/receipts", (_req, res) => {
    const receiptsDir = path.join(config.rootDir, "artifacts", "receipts");
    const filenames = [
      "order-accepted-receipt.json",
      "order-rejected-receipt.json",
      "batch-processed-receipt.json",
      "resolution-finalized-receipt.json",
      "claim-success-receipt.json",
      "claim-failure-receipt.json",
      "success-receipt.json",
      "failure-receipt.json",
      "pending-approval-receipt.json"
    ];

    const payload = filenames
      .map((filename) => {
        const fullPath = path.join(receiptsDir, filename);
        if (!fs.existsSync(fullPath)) {
          return null;
        }
        try {
          return JSON.parse(fs.readFileSync(fullPath, "utf8"));
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);

    res.json({ receipts: payload });
  });

  app.post("/api/export-trace", (_req, res) => {
    const traceSnapshot = {
      generatedAt: new Date().toISOString(),
      note: "Trace index generated by API",
      files: ["full-flow.jsonl", "bite-ctx-events.json", "tx-receipts.json"],
      status: "ok"
    };

    writeJsonTrace("trace-index.json", traceSnapshot);
    res.json(traceSnapshot);
  });

  return app;
}
