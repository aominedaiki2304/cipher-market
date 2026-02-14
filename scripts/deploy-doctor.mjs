import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  isAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });

const DEFAULT_RPC = "https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox";
const DEFAULT_CHAIN_ID = 103698795;

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[doctor:error] ${message}`);
  process.exit(1);
});

async function main() {
  const rpcUrl = process.env.DEPLOY_RPC_URL || process.env.RPC_URL || DEFAULT_RPC;
  const expectedChainId = Number(process.env.DEPLOY_CHAIN_ID || process.env.CHAIN_ID || DEFAULT_CHAIN_ID);

  const deployer = resolveDeployer();
  const client = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1 })
  });

  const report = {
    rpcUrl,
    expectedChainId,
    deployerAddress: deployer.address,
    checks: {
      rpcReachable: false,
      chainIdMatch: false,
      nativeBalance: "unknown",
      sendRawTransactionSupported: false,
      sendTransactionProbe: "unknown"
    },
    notes: []
  };

  try {
    const chainId = await client.getChainId();
    report.checks.rpcReachable = true;
    report.chainId = Number(chainId);
    report.checks.chainIdMatch = Number(chainId) === expectedChainId;
    if (!report.checks.chainIdMatch) {
      report.notes.push(`RPC chainId is ${chainId} but expected ${expectedChainId}`);
    }
  } catch (error) {
    report.notes.push(`RPC connectivity failed: ${sanitizeError(error)}`);
    printReport(report);
    return;
  }

  if (deployer.address) {
    try {
      const balance = await client.getBalance({ address: deployer.address });
      report.checks.nativeBalance = formatEther(balance);
      if (balance === 0n) {
        report.notes.push("Deployer has zero native balance.");
      }
    } catch (error) {
      report.notes.push(`Balance check failed: ${sanitizeError(error)}`);
    }
  } else {
    report.notes.push("No deployer address configured.");
  }

  try {
    await client.request({
      method: "eth_sendRawTransaction",
      params: ["0x00"]
    });
    report.checks.sendRawTransactionSupported = true;
  } catch (error) {
    const reason = collectRpcErrorDetails(error);
    const normalized = reason.toLowerCase();

    if (normalized.includes("invalid transaction format")) {
      report.checks.sendRawTransactionSupported = true;
    } else if (/method not found|does not exist|unsupported/i.test(normalized)) {
      report.checks.sendRawTransactionSupported = false;
      report.notes.push(`RPC rejects eth_sendRawTransaction: ${reason}`);
    } else {
      report.checks.sendRawTransactionSupported = true;
    }
  }

  try {
    const from = deployer.address || "0x1111111111111111111111111111111111111111";
    const to = deployer.address || from;
    await client.request({
      method: "eth_sendTransaction",
      params: [{ from, to, value: "0x0" }]
    });
    report.checks.sendTransactionProbe = "accepted";
  } catch (error) {
    const reason = sanitizeError(error);
    report.checks.sendTransactionProbe = reason;
    if (/rejected by user/i.test(reason)) {
      report.notes.push(
        "RPC eth_sendTransaction requires an interactive signer/session; not suitable for unattended server deploy."
      );
    }
  }

  printReport(report);
}

function resolveDeployer() {
  const deployerPk = process.env.DEPLOYER_PRIVATE_KEY || "";
  const deployerAddress = process.env.DEPLOYER_ADDRESS || "";

  if (/^0x[0-9a-fA-F]{64}$/.test(deployerPk)) {
    return { address: privateKeyToAccount(deployerPk).address };
  }
  if (isAddress(deployerAddress)) {
    return { address: getAddress(deployerAddress) };
  }
  return { address: null };
}

function printReport(report) {
  console.log(JSON.stringify(report, null, 2));
}

function sanitizeError(error) {
  if (!error) return "Unknown error";
  const candidate = error.shortMessage || error.details || error.message || String(error);
  return String(candidate).replace(/\s+/g, " ").trim().slice(0, 260);
}

function collectRpcErrorDetails(error) {
  return [
    error?.details,
    error?.cause?.details,
    error?.cause?.message,
    error?.shortMessage,
    error?.message
  ]
    .filter(Boolean)
    .map((x) => String(x))
    .join(" | ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
