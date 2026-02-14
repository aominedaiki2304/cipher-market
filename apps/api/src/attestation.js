import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  recoverMessageAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

const batchParams = parseAbiParameters(
  "address contractAddress, uint256 chainId, uint256 marketId, uint256 batchId, bytes32 ordersRoot, uint64 expiry"
);
const resolutionParams = parseAbiParameters(
  "address contractAddress, uint256 chainId, uint256 marketId, uint8 outcome, bytes32 evidenceHash, uint64 expiry"
);
const outcomeRevealParams = parseAbiParameters(
  "address contractAddress, uint256 chainId, uint256 marketId, bytes32 commitmentHash, uint64 expiry"
);

export function createBatchTriggerDigest({
  contractAddress,
  chainId = config.chainId,
  marketId,
  batchId,
  ordersRoot,
  expiry
}) {
  return keccak256(
    encodeAbiParameters(batchParams, [
      getAddress(contractAddress),
      BigInt(chainId),
      BigInt(marketId),
      BigInt(batchId),
      ordersRoot,
      Number(expiry)
    ])
  );
}

export function createResolutionDigest({
  contractAddress,
  chainId = config.chainId,
  marketId,
  outcome,
  evidenceHash,
  expiry
}) {
  return keccak256(
    encodeAbiParameters(resolutionParams, [
      getAddress(contractAddress),
      BigInt(chainId),
      BigInt(marketId),
      Number(outcome),
      evidenceHash,
      Number(expiry)
    ])
  );
}

export function createOutcomeRevealDigest({
  contractAddress,
  chainId = config.chainId,
  marketId,
  commitmentHash,
  expiry
}) {
  return keccak256(
    encodeAbiParameters(outcomeRevealParams, [
      getAddress(contractAddress),
      BigInt(chainId),
      BigInt(marketId),
      commitmentHash,
      Number(expiry)
    ])
  );
}

async function signDigest(digest) {
  if (!config.attestorPrivateKey || config.attestorPrivateKey === "0x") {
    throw new Error("ATTESTOR_PRIVATE_KEY is required for attestation signing");
  }

  const account = privateKeyToAccount(config.attestorPrivateKey);
  const signature = await account.signMessage({ message: { raw: digest } });
  const recoveredAddress = await recoverMessageAddress({
    message: { raw: digest },
    signature
  });

  return {
    digest,
    signature,
    attestorAddress: account.address,
    recoveredAddress
  };
}

export function createAttestationDigest(payload) {
  return createBatchTriggerDigest(payload);
}

export async function signBatchTriggerAttestation(payload) {
  const digest = createBatchTriggerDigest(payload);
  return signDigest(digest);
}

export async function signResolutionAttestation(payload) {
  const digest = createResolutionDigest(payload);
  return signDigest(digest);
}

export async function signOutcomeRevealAttestation(payload) {
  const digest = createOutcomeRevealDigest(payload);
  return signDigest(digest);
}
