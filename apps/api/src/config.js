import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootEnv = path.resolve(__dirname, "../../../.env");

dotenv.config({ path: rootEnv });

validateAttestorKey();
validateRelayerKey();
const resolvedAttestorAddress = resolveAttestorAddress();
const resolvedRelayerAddress = resolveRelayerAddress();

export const config = {
  // Render/Vercel style platforms provide `PORT`; keep `API_PORT` for local/dev.
  apiPort: Number(process.env.PORT || process.env.API_PORT || 8787),
  rpcUrl:
    process.env.RPC_URL ||
    "https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox",
  chainId: Number(process.env.CHAIN_ID || 103698795),
  collateralToken:
    process.env.USDC_ADDRESS || "0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8",
  attestorPrivateKey: process.env.ATTESTOR_PRIVATE_KEY || "",
  attestorAddress: resolvedAttestorAddress,
  relayerPrivateKey:
    process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || "",
  relayerAddress: resolvedRelayerAddress,
  defaultContractAddress:
    process.env.PRIVATE_PREDICTION_MARKET_ADDRESS ||
    process.env.PRIVATE_PROCUREMENT_ADDRESS ||
    "",
  rootDir: path.resolve(__dirname, "../../..")
};

function validateAttestorKey() {
  const key = process.env.ATTESTOR_PRIVATE_KEY || "";
  if (!key || key === "0x") return;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("ATTESTOR_PRIVATE_KEY must be 32-byte hex prefixed by 0x");
  }
}

function validateRelayerKey() {
  const key = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || "";
  if (!key || key === "0x") return;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("RELAYER_PRIVATE_KEY/DEPLOYER_PRIVATE_KEY must be 32-byte hex prefixed by 0x");
  }
}

function resolveAttestorAddress() {
  const explicit = process.env.ATTESTOR_ADDRESS || "";
  if (explicit) return explicit;

  const key = process.env.ATTESTOR_PRIVATE_KEY || "";
  if (/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return privateKeyToAccount(key).address;
  }

  return "";
}

function resolveRelayerAddress() {
  const explicit = process.env.RELAYER_ADDRESS || "";
  if (explicit) return explicit;

  const key = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || "";
  if (/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return privateKeyToAccount(key).address;
  }

  return "";
}
