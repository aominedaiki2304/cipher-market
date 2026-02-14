import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
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
  console.error(`[deploy:error] ${message}`);
  process.exit(1);
});

async function main() {
  const rpcUrl = process.env.DEPLOY_RPC_URL || process.env.RPC_URL || DEFAULT_RPC;
  const chainId = Number(process.env.DEPLOY_CHAIN_ID || process.env.CHAIN_ID || DEFAULT_CHAIN_ID);
  const deployerPk = process.env.DEPLOYER_PRIVATE_KEY || "";
  const deployerAddressEnv = process.env.DEPLOYER_ADDRESS || "";
  const deployViaRpcAccount = process.env.DEPLOY_VIA_RPC_ACCOUNT === "1";

  const deployConfig = resolveDeployerConfig({
    deployerPk,
    deployerAddressEnv,
    deployViaRpcAccount
  });

  const contractPath = path.join(root, "contracts", "src", "PrivateProcurement.sol");
  const compileResult = compileContract(contractPath);
  const contract = compileResult.contracts["PrivateProcurement.sol"]?.PrivateProcurement;
  if (!contract?.abi || !contract?.evm?.bytecode?.object) {
    throw new Error("Compilation succeeded but PrivateProcurement artifact missing");
  }

  const bytecode = `0x${contract.evm.bytecode.object}`;
  const abi = contract.abi;

  const chain = {
    id: chainId,
    name: "BITE Sandbox",
    network: "bite-sandbox",
    nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] }
    }
  };

  const transport = http(rpcUrl, { retryCount: 2 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    chain,
    transport,
    account: deployConfig.localAccount || undefined
  });

  console.log(`[deploy] mode: ${deployConfig.mode}`);
  console.log(`[deploy] account: ${deployConfig.address}`);
  console.log(`[deploy] rpc: ${rpcUrl}`);
  console.log(`[deploy] chainId (expected): ${chainId}`);

  await runPreflightChecks({
    publicClient,
    expectedChainId: chainId,
    deployConfig
  });

  const gasPrice = await publicClient.getGasPrice();
  console.log(`[deploy] gasPrice: ${gasPrice.toString()} wei`);

  let hash;
  try {
    if (deployConfig.mode === "signed-raw") {
      hash = await deployWithSignedRaw({
        publicClient,
        account: deployConfig.localAccount,
        chainId,
        bytecode,
        gasPrice
      });
    } else {
      hash = await walletClient.deployContract({
        abi,
        bytecode,
        account: deployConfig.txAccount,
        gasPrice
      });
    }
  } catch (error) {
    throw new Error(buildDeployErrorMessage(error, deployConfig, rpcUrl));
  }

  console.log(`[deploy] txHash: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") {
    throw new Error(`Deployment failed with status ${receipt.status}`);
  }

  const address = receipt.contractAddress;
  if (!address) {
    throw new Error("Deployment receipt missing contractAddress");
  }

  const deployment = {
    contractName: "PrivateProcurement",
    address,
    txHash: hash,
    chainId,
    rpcUrl,
    deployer: deployConfig.address,
    blockNumber: receipt.blockNumber.toString(),
    deployedAt: new Date().toISOString(),
    abi
  };

  const deploymentDir = path.join(root, "artifacts", "deployment");
  fs.mkdirSync(deploymentDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentDir, "private-procurement.json"),
    JSON.stringify(deployment, null, 2)
  );

  setEnvValue(path.join(root, ".env"), "PRIVATE_PROCUREMENT_ADDRESS", address);
  setEnvValue(path.join(root, ".env"), "RPC_URL", rpcUrl);
  setEnvValue(path.join(root, ".env"), "CHAIN_ID", String(chainId));

  const webEnvLocal = path.join(root, "apps", "web", ".env.local");
  setEnvValue(webEnvLocal, "VITE_PRIVATE_PROCUREMENT_ADDRESS", address);
  setEnvValue(webEnvLocal, "VITE_CHAIN_ID", String(chainId));
  setEnvValue(webEnvLocal, "VITE_RPC_URL", rpcUrl);
  setEnvValue(webEnvLocal, "VITE_API_URL", process.env.VITE_API_URL || "http://localhost:8787");

  const apiEnvLocal = path.join(root, "apps", "api", ".env.local");
  setEnvValue(apiEnvLocal, "PRIVATE_PROCUREMENT_ADDRESS", address);
  setEnvValue(apiEnvLocal, "RPC_URL", rpcUrl);
  setEnvValue(apiEnvLocal, "CHAIN_ID", String(chainId));

  console.log(`[deploy] contract address: ${address}`);
  console.log("[deploy] wrote artifacts/deployment/private-procurement.json and synced env files");
}

function resolveDeployerConfig({ deployerPk, deployerAddressEnv, deployViaRpcAccount }) {
  if (/^0x[0-9a-fA-F]{64}$/.test(deployerPk)) {
    const localAccount = privateKeyToAccount(deployerPk);
    return {
      mode: "signed-raw",
      address: localAccount.address,
      localAccount,
      txAccount: localAccount
    };
  }

  if (deployViaRpcAccount && isAddress(deployerAddressEnv)) {
    const address = getAddress(deployerAddressEnv);
    return {
      mode: "rpc-account",
      address,
      localAccount: null,
      txAccount: address
    };
  }

  throw new Error(
    "No deploy account configured. Set DEPLOYER_PRIVATE_KEY or enable DEPLOY_VIA_RPC_ACCOUNT=1 with DEPLOYER_ADDRESS."
  );
}

async function runPreflightChecks({ publicClient, expectedChainId, deployConfig }) {
  let rpcChainId;
  try {
    rpcChainId = await publicClient.getChainId();
  } catch (error) {
    throw new Error(`RPC chain check failed: ${sanitizeError(error)}`);
  }

  console.log(`[deploy] chainId (rpc): ${rpcChainId}`);
  if (Number(rpcChainId) !== Number(expectedChainId)) {
    console.warn(
      `[deploy:warn] Expected chain ${expectedChainId} but RPC reports ${rpcChainId}.`
    );
  }

  try {
    const nativeBalance = await publicClient.getBalance({
      address: deployConfig.address
    });
    console.log(`[deploy] native balance: ${formatEther(nativeBalance)} sFUEL`);
    if (nativeBalance === 0n) {
      console.warn(`[deploy:warn] ${deployConfig.address} has zero native balance.`);
    }
  } catch (error) {
    console.warn(`[deploy:warn] could not read deployer balance: ${sanitizeError(error)}`);
  }

  if (deployConfig.mode === "signed-raw") {
    const rawTxSupport = await checkRawTxSupport(publicClient);
    if (!rawTxSupport.supported) {
      throw new Error(
        `RPC rejects eth_sendRawTransaction (${rawTxSupport.reason}). Use an RPC that supports signed raw tx broadcast or switch to DEPLOY_VIA_RPC_ACCOUNT=1 with an unlocked DEPLOYER_ADDRESS.`
      );
    }
  }
}

async function checkRawTxSupport(publicClient) {
  try {
    await publicClient.request({
      method: "eth_sendRawTransaction",
      params: ["0x00"]
    });
    return { supported: true, reason: "accepted test call" };
  } catch (error) {
    const rawDetails = collectRpcErrorDetails(error);
    const normalized = rawDetails.toLowerCase();

    if (normalized.includes("invalid transaction format")) {
      return { supported: true, reason: rawDetails };
    }

    if (/method not found|does not exist|unsupported/i.test(normalized)) {
      return { supported: false, reason: rawDetails };
    }

    // Conservative default: if endpoint responds to the method with a typed RPC error,
    // treat it as method-available and let real deployment attempt decide.
    return { supported: true, reason: rawDetails };
  }
}

function buildDeployErrorMessage(error, deployConfig, rpcUrl) {
  const reason = sanitizeError(error);
  const hints = [];

  if (/eth_sendRawTransaction.*not supported|method .* not supported/i.test(reason)) {
    hints.push("RPC does not accept signed raw transactions.");
    hints.push("Try DEPLOY_VIA_RPC_ACCOUNT=1 with an unlocked DEPLOYER_ADDRESS, or switch RPC.");
  }
  if (/balance is too low|insufficient funds|insufficient balance/i.test(reason)) {
    hints.push(`Fund deployer ${deployConfig.address} with native gas token.`);
  }
  if (/fetch failed|enotfound|network/i.test(reason)) {
    hints.push(`RPC endpoint may be unreachable from this environment: ${rpcUrl}`);
  }

  const suffix = hints.length
    ? `\n[deploy:hints]\n- ${hints.join("\n- ")}`
    : "";

  return `Deployment transaction failed: ${reason}${suffix}`;
}

function sanitizeError(error) {
  if (!error) return "Unknown error";

  const candidates = [
    error.shortMessage,
    error.details,
    error.message
  ].filter(Boolean);

  const oneLine = String(candidates[0] || "Unknown error")
    .replace(/\s+/g, " ")
    .trim();

  return oneLine.slice(0, 260);
}

async function deployWithSignedRaw({ publicClient, account, chainId, bytecode, gasPrice }) {
  const nonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending"
  });

  let gas;
  try {
    gas = await publicClient.estimateGas({
      account: account.address,
      data: bytecode
    });
  } catch (_error) {
    gas = 4_500_000n;
  }

  const gasWithBuffer = (gas * 120n) / 100n;
  const rawTx = await account.signTransaction({
    chainId,
    nonce,
    gasPrice,
    gas: gasWithBuffer,
    data: bytecode,
    value: 0n
  });

  return publicClient.request({
    method: "eth_sendRawTransaction",
    params: [rawTx]
  });
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

function compileContract(entryPath) {
  const entryDir = path.dirname(entryPath);
  const entrySource = fs.readFileSync(entryPath, "utf8");
  const input = {
    language: "Solidity",
    sources: {
      "PrivateProcurement.sol": {
        content: entrySource
      }
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "istanbul",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"]
        }
      }
    }
  };

  const outputRaw = solc.compile(JSON.stringify(input), {
    import: (importPath) => {
      const normalized = importPath.replace(/^\.\//, "");
      const candidates = [
        path.join(entryDir, importPath),
        path.join(entryDir, normalized),
        path.join(entryDir, "interfaces", path.basename(importPath)),
        path.join(entryDir, "libraries", path.basename(importPath)),
        path.join(entryDir, "mocks", path.basename(importPath))
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return { contents: fs.readFileSync(candidate, "utf8") };
        }
      }

      return { error: `File not found: ${importPath}` };
    }
  });

  const output = JSON.parse(outputRaw);
  if (output.errors?.length) {
    const hardErrors = output.errors.filter((e) => e.severity === "error");
    for (const e of output.errors) {
      const prefix = e.severity === "error" ? "[solc:error]" : "[solc:warn]";
      console.log(`${prefix} ${e.formattedMessage.trim()}`);
    }
    if (hardErrors.length) {
      throw new Error("Solidity compilation failed");
    }
  }

  return output;
}

function setEnvValue(filePath, key, value) {
  const escaped = String(value).replace(/\n/g, "");
  const nextLine = `${key}=${escaped}`;
  let content = "";

  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf8");
  }

  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  const idx = lines.findIndex((line) => line.startsWith(`${key}=`));

  if (idx >= 0) {
    lines[idx] = nextLine;
  } else {
    lines.push(nextLine);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}
