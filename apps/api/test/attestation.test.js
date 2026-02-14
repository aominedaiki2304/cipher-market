import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import {
  createBatchTriggerDigest,
  createResolutionDigest
} from "../src/attestation.js";

test("batch trigger digest can be recovered with standard message signing", async () => {
  const privateKey = "0x59c6995e998f97a5a0044966f0945382f7fc95f2f95fbb4d43f8b5ef4a6b6f9d";
  const account = privateKeyToAccount(privateKey);

  const digest = createBatchTriggerDigest({
    contractAddress: "0x000000000000000000000000000000000000c0de",
    chainId: 103698795,
    marketId: 42,
    batchId: 3,
    ordersRoot: "0x1111111111111111111111111111111111111111111111111111111111111111",
    expiry: 1999999999
  });

  const signature = await account.signMessage({ message: { raw: digest } });
  const recovered = await recoverMessageAddress({ message: { raw: digest }, signature });

  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
});

test("resolution digest can be recovered with standard message signing", async () => {
  const privateKey = "0x8b3a350cf5c34c9194ca7f7d27c4c4f2118e83b8f10c8e4f4e7f7f63f84cf6d8";
  const account = privateKeyToAccount(privateKey);

  const digest = createResolutionDigest({
    contractAddress: "0x000000000000000000000000000000000000c0de",
    chainId: 103698795,
    marketId: 12,
    outcome: 2,
    evidenceHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    expiry: 1999999999
  });

  const signature = await account.signMessage({ message: { raw: digest } });
  const recovered = await recoverMessageAddress({ message: { raw: digest }, signature });

  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
});

test("batch trigger digest changes when chainId changes", () => {
  const payload = {
    contractAddress: "0x000000000000000000000000000000000000c0de",
    marketId: 42,
    batchId: 3,
    ordersRoot: "0x1111111111111111111111111111111111111111111111111111111111111111",
    expiry: 1999999999
  };

  const digestA = createBatchTriggerDigest({ ...payload, chainId: 103698795 });
  const digestB = createBatchTriggerDigest({ ...payload, chainId: 324705682 });

  assert.notEqual(digestA, digestB);
});

test("resolution digest changes when chainId changes", () => {
  const payload = {
    contractAddress: "0x000000000000000000000000000000000000c0de",
    marketId: 12,
    outcome: 1,
    evidenceHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    expiry: 1999999999
  };

  const digestA = createResolutionDigest({ ...payload, chainId: 103698795 });
  const digestB = createResolutionDigest({ ...payload, chainId: 324705682 });

  assert.notEqual(digestA, digestB);
});
