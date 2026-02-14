import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { BITE } from "@skalenetwork/bite";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  parseEventLogs,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbiParameters,
  parseUnits,
  stringToBytes
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });

const RPC_URL = process.env.RPC_URL || "https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox";
const CHAIN_ID = Number(process.env.CHAIN_ID || 103698795);
const CONTRACT_ADDRESS = getAddress(
  process.env.PRIVATE_PREDICTION_MARKET_ADDRESS || "0x0000000000000000000000000000000000000000"
);
const USDC_ADDRESS = getAddress(
  process.env.USDC_ADDRESS || "0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8"
);

const deployerPk = ensurePrivateKey(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
const traderAPk = ensurePrivateKey(process.env.TRADER_A, "TRADER_A");
const traderBPk = ensurePrivateKey(process.env.TRADER_B, "TRADER_B");
const attestorPk = ensurePrivateKey(process.env.ATTESTOR_PRIVATE_KEY, "ATTESTOR_PRIVATE_KEY");

const deployer = privateKeyToAccount(deployerPk);
const traderA = privateKeyToAccount(traderAPk);
const traderB = privateKeyToAccount(traderBPk);
const attestor = privateKeyToAccount(attestorPk);

const chain = {
  id: CHAIN_ID,
  name: "SKALE BITE v2 Sandbox",
  nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] }
  }
};

const transport = http(RPC_URL, { retryCount: 5, retryDelay: 1_000, timeout: 60_000 });
const publicClient = createPublicClient({ chain, transport });
const walletA = createWalletClient({ chain, transport, account: traderA });
const walletB = createWalletClient({ chain, transport, account: traderB });
const walletDeployer = createWalletClient({ chain, transport, account: deployer });

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
];

const marketAbi = JSON.parse(
  fs.readFileSync(path.join(root, "artifacts", "deployment", "private-prediction-market.json"), "utf8")
).abi;

const orderArgs = parseAbiParameters(
  "address trader, uint8 side, uint256 maxCost, uint16 limitPriceBps, uint256 nonce"
);

async function main() {
  if (CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000") {
    throw new Error("PRIVATE_PREDICTION_MARKET_ADDRESS is not configured.");
  }

  console.log("[test] trader A", traderA.address);
  console.log("[test] trader B", traderB.address);
  console.log("[test] attestor", attestor.address);
  console.log("[test] contract", CONTRACT_ADDRESS);

  const before = await readBalances();
  logBalances("before", before);

  await ensureTraderFunding();

  const now = Math.floor(Date.now() / 1000);
  const question = `TRADER_A_vs_TRADER_B_${now}`;
  const questionHash = keccak256(stringToBytes(question));
  const metadataHash = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }],
      [question, BigInt(now)]
    )
  );

  const orderDepositUnit = parseUnits("1", 6);
  const maxStakePerOrder = parseUnits("1", 6);
  const maxTotalStake = parseUnits("10", 6);
  const stakeA = parseUnits("0.7", 6);
  const stakeB = parseUnits("0.4", 6);

  const createTx = await walletA.writeContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "createMarket",
    args: [
      {
        collateralToken: USDC_ADDRESS,
        questionHash,
        metadataHash,
        openTime: now - 60,
        closeTime: now + 900,
        resolveBy: now + 3600,
        orderDepositUnit,
        maxStakePerOrder,
        maxTotalStake,
        attestor: attestor.address,
        approver: traderA.address,
        disputeWindowSeconds: 600,
        allowlistEnabled: false,
        allowlist: []
      }
    ],
    account: traderA
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });

  const nextMarketId = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "nextMarketId"
  });
  const marketId = Number(nextMarketId - 1n);
  console.log("[test] created marketId", marketId, "tx", createTx);

  const approveATx = await walletA.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [CONTRACT_ADDRESS, orderDepositUnit],
    account: traderA
  });
  await publicClient.waitForTransactionReceipt({ hash: approveATx });

  const approveBTx = await walletB.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [CONTRACT_ADDRESS, orderDepositUnit],
    account: traderB
  });
  await publicClient.waitForTransactionReceipt({ hash: approveBTx });

  const orderA = await buildEncryptedOrder({
    trader: traderA.address,
    side: 1,
    stake: stakeA,
    limitPriceBps: 10000,
    nonce: now + 1
  });
  const orderB = await buildEncryptedOrder({
    trader: traderB.address,
    side: 2,
    stake: stakeB,
    limitPriceBps: 10000,
    nonce: now + 2
  });

  const submitATx = await walletA.writeContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "submitEncryptedOrder",
    args: [BigInt(marketId), orderA.encryptedPayload, orderA.commitmentHash],
    account: traderA
  });
  const submitAReceipt = await publicClient.waitForTransactionReceipt({ hash: submitATx });
  const submitALogs = parseEventLogs({
    abi: marketAbi,
    logs: submitAReceipt.logs,
    eventName: "OrderSubmitted"
  });
  const orderIdA = Number(submitALogs?.[0]?.args?.orderId ?? 0);

  const submitBTx = await walletB.writeContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "submitEncryptedOrder",
    args: [BigInt(marketId), orderB.encryptedPayload, orderB.commitmentHash],
    account: traderB
  });
  const submitBReceipt = await publicClient.waitForTransactionReceipt({ hash: submitBTx });
  const submitBLogs = parseEventLogs({
    abi: marketAbi,
    logs: submitBReceipt.logs,
    eventName: "OrderSubmitted"
  });
  const orderIdB = Number(submitBLogs?.[0]?.args?.orderId ?? 0);

  if (!Number.isFinite(orderIdA) || orderIdA <= 0) {
    throw new Error("OrderSubmitted event not found for trader A submission.");
  }
  if (!Number.isFinite(orderIdB) || orderIdB <= 0) {
    throw new Error("OrderSubmitted event not found for trader B submission.");
  }

  const [orderAView, orderBView, marketView] = await Promise.all([
    publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "getOrder",
      args: [BigInt(orderIdA)]
    }),
    publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "getOrder",
      args: [BigInt(orderIdB)]
    }),
    publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "getMarket",
      args: [BigInt(marketId)]
    })
  ]);

  const assertions = {
    marketCreated: Number(marketView.id) === marketId,
    stateOpen: Number(marketView.state) === 1,
    orderATraderMatches: getAddress(orderAView.trader) === traderA.address,
    orderBTraderMatches: getAddress(orderBView.trader) === traderB.address,
    orderCommitmentAMatches: orderAView.commitmentHash.toLowerCase() === orderA.commitmentHash.toLowerCase(),
    orderCommitmentBMatches: orderBView.commitmentHash.toLowerCase() === orderB.commitmentHash.toLowerCase()
  };

  const after = await readBalances();
  logBalances("after", after);

  const result = {
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    contractAddress: CONTRACT_ADDRESS,
    traderA: traderA.address,
    traderB: traderB.address,
    attestor: attestor.address,
    marketId,
    tx: {
      createMarket: createTx,
      approveA: approveATx,
      approveB: approveBTx,
      submitOrderA: submitATx,
      submitOrderB: submitBTx
    },
    ids: {
      orderA: orderIdA,
      orderB: orderIdB
    },
    encryption: {
      orderA: { mode: orderA.mode, encryptionError: orderA.encryptionError },
      orderB: { mode: orderB.mode, encryptionError: orderB.encryptionError }
    },
    assertions,
    balancesBefore: before,
    balancesAfter: after,
    createReceiptStatus: createReceipt.status
  };

  const outPath = path.join(root, "artifacts", "traces", "trader-ab-test.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log("[test] result written:", outPath);
  console.log("[test] assertions:", JSON.stringify(assertions));
}

async function ensureTraderFunding() {
  const traderBNative = await publicClient.getBalance({ address: traderB.address });
  if (traderBNative < parseUnits("0.005", 18)) {
    const tx = await walletDeployer.sendTransaction({
      account: deployer,
      to: traderB.address,
      value: parseUnits("0.02", 18),
      chain
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log("[test] topped up trader B native", tx);
  }

  const traderBUSDC = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [traderB.address]
  });
  if (traderBUSDC < parseUnits("2", 6)) {
    const tx = await walletDeployer.writeContract({
      account: deployer,
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "transfer",
      args: [traderB.address, parseUnits("5", 6)],
      chain
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log("[test] topped up trader B USDC", tx);
  }
}

async function buildEncryptedOrder({ trader, side, stake, limitPriceBps = 10000, nonce }) {
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
    const bite = new BITE(RPC_URL);
    encryptedPayload = await bite.encryptMessage(encodedPayload);
    mode = "bite-v2";
  } catch (error) {
    encryptionError = error instanceof Error ? error.message : "unknown encryption error";
  }

  return {
    encodedPayload,
    encryptedPayload,
    commitmentHash,
    mode,
    encryptionError
  };
}

async function readBalances() {
  // Read sequentially to avoid transient RPC flakiness when sending parallel requests.
  const aNative = await publicClient.getBalance({ address: traderA.address });
  const bNative = await publicClient.getBalance({ address: traderB.address });
  const aUsdc = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [traderA.address]
  });
  const bUsdc = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [traderB.address]
  });

  return {
    traderA: {
      address: traderA.address,
      native: formatEther(aNative),
      usdc: formatUnits(aUsdc, 6)
    },
    traderB: {
      address: traderB.address,
      native: formatEther(bNative),
      usdc: formatUnits(bUsdc, 6)
    }
  };
}

function logBalances(label, balances) {
  console.log(`[test] balances ${label}`);
  console.log("  traderA", balances.traderA.address, "native", balances.traderA.native, "usdc", balances.traderA.usdc);
  console.log("  traderB", balances.traderB.address, "native", balances.traderB.native, "usdc", balances.traderB.usdc);
}

function ensurePrivateKey(value, name) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error("[test:error]", msg);
  process.exit(1);
});
