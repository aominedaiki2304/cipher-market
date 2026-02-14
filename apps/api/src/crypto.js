import { BITE } from "@skalenetwork/bite";
import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters
} from "viem";
import { config } from "./config.js";

const orderArgs = parseAbiParameters(
  "address trader, uint8 side, uint256 maxCost, uint16 limitPriceBps, uint256 nonce"
);

export async function encryptOrderPayload({ trader, side, stake, limitPriceBps = 10000, nonce }) {
  if (!isAddress(trader)) {
    throw new Error("trader must be a valid EVM address");
  }

  const encodedPayload = encodeAbiParameters(orderArgs, [
    getAddress(trader),
    Number(side),
    BigInt(stake),
    Number(limitPriceBps),
    BigInt(nonce)
  ]);

  const commitmentHash = keccak256(encodedPayload);

  let encryptedPayload = encodedPayload;
  let mode = "simulated";
  let encryptionError = null;

  try {
    const bite = new BITE(config.rpcUrl);
    encryptedPayload = await bite.encryptMessage(encodedPayload);
    mode = "bite-v2";
  } catch (error) {
    encryptionError = error instanceof Error ? error.message : "Unknown encryption error";
  }

  return {
    mode,
    trader: getAddress(trader),
    side: Number(side),
    stake: String(stake),
    limitPriceBps: Number(limitPriceBps),
    nonce: Number(nonce),
    encodedPayload,
    encryptedPayload,
    commitmentHash,
    encryptionError
  };
}
