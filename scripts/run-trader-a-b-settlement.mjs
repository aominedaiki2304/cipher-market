import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { BITE } from "@skalenetwork/bite";
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  encodeAbiParameters,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEther,
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

const traderAPk = ensurePrivateKey(process.env.TRADER_A, "TRADER_A");
const traderBPk = ensurePrivateKey(process.env.TRADER_B, "TRADER_B");
const attestorPk = ensurePrivateKey(process.env.ATTESTOR_PRIVATE_KEY, "ATTESTOR_PRIVATE_KEY");

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
const walletAttestor = createWalletClient({ chain, transport, account: attestor });

const deployment = JSON.parse(
  fs.readFileSync(path.join(root, "artifacts", "deployment", "private-prediction-market.json"), "utf8")
);
const marketAbi = deployment.abi;

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
  }
];

const MarketState = {
  CREATED: 0,
  OPEN: 1,
  ORDER_CTX_REQUESTED: 2,
  BATCH_PROCESSED: 3,
  OUTCOME_COMMITTED: 4,
  OUTCOME_CTX_REQUESTED: 5,
  RESOLUTION_PROPOSED: 6,
  IN_DISPUTE: 7,
  RESOLVED: 8,
  CANCELLED: 9
};

const Outcome = {
  YES: 1
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CTX_GAS_PAYMENT = parseEther(process.env.CTX_GAS_PAYMENT || "0.06");
const CTX_MIN_CTXSENDER_BALANCE = parseEther("0.001");

const orderArgs = parseAbiParameters(
  "address trader, uint8 side, uint256 maxCost, uint16 limitPriceBps, uint256 nonce"
);
const outcomeArgs = parseAbiParameters("uint256 marketId, uint8 outcome, bytes32 evidenceHash, uint256 nonce");

async function main() {
  if (CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000") {
    throw new Error("PRIVATE_PREDICTION_MARKET_ADDRESS is not configured.");
  }

  // Prefer settling the latest `run-trader-a-b-test.mjs` market if it exists, but fall back to creating a fresh market.
  // A market can get stuck in ORDER_CTX_REQUESTED if it was triggered without transferring CTX gas payment at submit time.
  const testTracePath = path.join(root, "artifacts", "traces", "trader-ab-test.json");
  const forceNew = process.env.FORCE_NEW_MARKET === "1";

  let setup = null;
  let marketId;
  let orderIds;

  if (!forceNew && fs.existsSync(testTracePath)) {
    try {
      const baseArtifact = JSON.parse(fs.readFileSync(testTracePath, "utf8"));
      const candidateMarketId = Number(baseArtifact.marketId);
      const candidateOrderIds = [
        Number(baseArtifact.ids?.orderA),
        Number(baseArtifact.ids?.orderB)
      ].filter((v) => Number.isFinite(v));

      if (candidateMarketId > 0 && candidateOrderIds.length > 0) {
        const marketView = await readMarket(candidateMarketId);
        const state = Number(marketView.state);
        if (state !== MarketState.ORDER_CTX_REQUESTED && state !== MarketState.CANCELLED) {
          marketId = candidateMarketId;
          orderIds = candidateOrderIds;
          setup = { from: "trader-ab-test.json", marketId, orderIds };
        } else {
          console.log("[settle] existing market is not settleable (state)", state, "creating new market");
        }
      }
    } catch (error) {
      console.log("[settle] failed reading trader-ab-test.json, creating new market");
    }
  }

  if (!marketId) {
    setup = await createDemoMarketAndOrders();
    marketId = Number(setup.marketId);
    orderIds = setup.orderIds.map(Number);
  }

  console.log("[settle] marketId", marketId, "orders", orderIds.join(","));
  console.log("[settle] traderA", traderA.address, "traderB", traderB.address, "attestor", attestor.address);

  const before = await readBalances();
  logBalances("before", before);

  const triggerResult = await maybeTriggerBatchDecrypt({ marketId, orderIds });
  const batchProcessedState = await waitForState(marketId, MarketState.BATCH_PROCESSED, 240_000);

  if (!batchProcessedState.reached) {
    throw new Error(
      `Market did not reach BATCH_PROCESSED in time. lastState=${batchProcessedState.lastStateCode}`
    );
  }

  const resolutionResult = await ensureResolved(marketId);
  const claimResult = await runClaims(marketId);

  const after = await readBalances();
  logBalances("after", after);

  const [marketView, posA, posB] = await Promise.all([
    readMarket(marketId),
    publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "getPosition",
      args: [BigInt(marketId), traderA.address]
    }),
    publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "getPosition",
      args: [BigInt(marketId), traderB.address]
    })
  ]);

  const result = {
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    contractAddress: CONTRACT_ADDRESS,
    marketId,
    orderIds,
    setup,
    triggerResult,
    resolutionResult,
    claimResult,
    marketStateAfter: Number(marketView.state),
    finalOutcome: Number(marketView.finalOutcome),
    positionsAfter: {
      traderA: {
        yesLots: posA.yesLots.toString(),
        noLots: posA.noLots.toString(),
        refundable: formatUnits(posA.refundable, 6),
        claimed: Boolean(posA.claimed)
      },
      traderB: {
        yesLots: posB.yesLots.toString(),
        noLots: posB.noLots.toString(),
        refundable: formatUnits(posB.refundable, 6),
        claimed: Boolean(posB.claimed)
      }
    },
    balancesBefore: before,
    balancesAfter: after
  };

  const outPath = path.join(root, "artifacts", "traces", "trader-ab-settlement.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log("[settle] result written:", outPath);
  console.log("[settle] finalOutcome:", result.finalOutcome, "marketState:", result.marketStateAfter);
}

async function maybeTriggerBatchDecrypt({ marketId, orderIds }) {
  const market = await readMarket(marketId);
  if (Number(market.state) >= MarketState.BATCH_PROCESSED) {
    return { skipped: true, reason: "already_batch_processed_or_beyond" };
  }
  if (Number(market.state) === MarketState.ORDER_CTX_REQUESTED) {
    return { skipped: true, reason: "already_ctx_requested" };
  }
  if (Number(market.state) !== MarketState.OPEN) {
    return { skipped: true, reason: `market_state_${Number(market.state)}_not_open` };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now < Number(market.closeTime)) {
    const waitSeconds = Number(market.closeTime) - now + 2;
    console.log("[settle] waiting for closeTime, seconds:", waitSeconds);
    await sleep(waitSeconds * 1000);
  }

  const [nextBatchId, orderViews] = await Promise.all([
    publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "nextBatchId"
    }),
    Promise.all(
      orderIds.map((id) =>
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "getOrder",
          args: [BigInt(id)]
        })
      )
    )
  ]);

  let rolling = keccak256("0x");
  for (let i = 0; i < orderIds.length; i++) {
    const orderId = BigInt(orderIds[i]);
    const order = orderViews[i];
    rolling = keccak256(
      encodePacked(
        ["bytes32", "uint256", "bytes32", "address"],
        [rolling, orderId, order.commitmentHash, order.trader]
      )
    );
  }
  const ordersRoot = rolling;
  const batchId = BigInt(nextBatchId);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 1800);

  const digest = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint64" }
      ],
      [CONTRACT_ADDRESS, BigInt(CHAIN_ID), BigInt(marketId), batchId, ordersRoot, expiry]
    )
  );
  const signature = await attestor.signMessage({ message: { raw: digest } });

  let triggerTx;
  let triggerValue = formatEther(CTX_GAS_PAYMENT);
  try {
    triggerTx = await walletA.writeContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "triggerBatchDecrypt",
      args: [
        BigInt(marketId),
        orderIds.map((id) => BigInt(id)),
        {
          batchId,
          expiry,
          ordersRoot
        },
        signature
      ],
      value: CTX_GAS_PAYMENT,
      account: traderA
    });
    await publicClient.waitForTransactionReceipt({ hash: triggerTx });
  } catch (error) {
    console.log("[settle] CTX-value trigger failed, retrying with zero value");
    triggerTx = await walletA.writeContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "triggerBatchDecrypt",
      args: [
        BigInt(marketId),
        orderIds.map((id) => BigInt(id)),
        {
          batchId,
          expiry,
          ordersRoot
        },
        signature
      ],
      value: 0n,
      account: traderA
    });
    await publicClient.waitForTransactionReceipt({ hash: triggerTx });
    triggerValue = "0";
  }

  console.log("[settle] trigger tx", triggerTx);

  const funded = triggerValue === "0" ? await maybeFundCtxSender(orderIds) : { skipped: true, reason: "paid_in_trigger" };

  return {
    skipped: false,
    batchId: Number(batchId),
    expiry: Number(expiry),
    ordersRoot,
    digest,
    signature,
    triggerTx,
    triggerValueEth: triggerValue,
    funded
  };
}

async function maybeFundCtxSender(orderIds) {
  const order0 = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "getOrder",
    args: [BigInt(orderIds[0])]
  });
  const ctxSender = getAddress(order0.ctxSender);
  if (ctxSender === ZERO_ADDRESS) {
    return { skipped: true, reason: "ctx_sender_not_set" };
  }

  const bal = await publicClient.getBalance({ address: ctxSender });
  if (bal >= CTX_MIN_CTXSENDER_BALANCE) {
    return { skipped: true, reason: "ctx_sender_already_funded", ctxSender, balance: formatEther(bal) };
  }

  const tx = await walletA.sendTransaction({
    account: traderA,
    to: ctxSender,
    value: CTX_GAS_PAYMENT,
    chain
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("[settle] funded ctxSender", ctxSender, "tx", tx);

  return { skipped: false, ctxSender, valueEth: formatEther(CTX_GAS_PAYMENT), tx };
}

async function createDemoMarketAndOrders() {
  const now = Math.floor(Date.now() / 1000);
  const question = `TRADER_A_vs_TRADER_B_FULLFLOW_${now}`;
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

  const closeSeconds = Number(process.env.DEMO_CLOSE_SECONDS || 45);
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
        closeTime: now + closeSeconds,
        resolveBy: now + 3600,
        orderDepositUnit,
        maxStakePerOrder,
        maxTotalStake,
        attestor: attestor.address,
        approver: traderA.address,
        disputeWindowSeconds: 300,
        allowlistEnabled: false,
        allowlist: []
      }
    ],
    account: traderA
  });
  await publicClient.waitForTransactionReceipt({ hash: createTx });

  const nextMarketId = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "nextMarketId"
  });
  const marketId = Number(nextMarketId - 1n);

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
    nonce: now + 1
  });
  const orderB = await buildEncryptedOrder({
    trader: traderB.address,
    side: 2,
    stake: stakeB,
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
  if (submitAReceipt.status !== "success") {
    throw new Error(`Trader A submitEncryptedOrder reverted. tx=${submitATx}`);
  }

  const submitBTx = await walletB.writeContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "submitEncryptedOrder",
    args: [BigInt(marketId), orderB.encryptedPayload, orderB.commitmentHash],
    account: traderB
  });
  const submitBReceipt = await publicClient.waitForTransactionReceipt({ hash: submitBTx });
  if (submitBReceipt.status !== "success") {
    throw new Error(`Trader B submitEncryptedOrder reverted. tx=${submitBTx}`);
  }

  const marketOrderIds = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "getMarketOrderIds",
    args: [BigInt(marketId)]
  });
  const orderIds = (Array.isArray(marketOrderIds) ? marketOrderIds : [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (orderIds.length < 2) {
    throw new Error(`Expected >=2 orders in market ${marketId}, got ${orderIds.length}.`);
  }

  return {
    marketId,
    orderIds,
    closeTime: now + closeSeconds,
    orderDepositUnit: formatUnits(orderDepositUnit, 6),
    stakes: {
      traderA: formatUnits(stakeA, 6),
      traderB: formatUnits(stakeB, 6)
    },
    encryption: {
      orderA: { mode: orderA.mode, encryptionError: orderA.encryptionError },
      orderB: { mode: orderB.mode, encryptionError: orderB.encryptionError }
    },
    tx: {
      createMarket: createTx,
      approveA: approveATx,
      approveB: approveBTx,
      submitOrderA: submitATx,
      submitOrderB: submitBTx
    }
  };
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

async function ensureResolved(marketId) {
  let market = await readMarket(marketId);
  const result = {
    commitTx: null,
    triggerTx: null,
    overrideTx: null,
    skipped: false
  };

  if (Number(market.state) === MarketState.RESOLVED) {
    result.skipped = true;
    return result;
  }

  // Commit an encrypted outcome and trigger CTX reveal if needed.
  if (Number(market.state) === MarketState.BATCH_PROCESSED) {
    const evidenceHash = keccak256(stringToBytes(`trader-ab-outcome-${Date.now()}`));
    const nonce = BigInt(Date.now());
    const encodedOutcome = encodeAbiParameters(outcomeArgs, [
      BigInt(marketId),
      Outcome.YES,
      evidenceHash,
      nonce
    ]);
    const commitmentHash = keccak256(encodedOutcome);

    let encryptedOutcome = encodedOutcome;
    let mode = "simulated";
    let encryptionError = null;
    try {
      const bite = new BITE(RPC_URL);
      encryptedOutcome = await bite.encryptMessage(encodedOutcome);
      mode = "bite-v2";
    } catch (error) {
      encryptionError = error instanceof Error ? error.message : "unknown encryption error";
    }

    const commitTx = await walletAttestor.writeContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "commitEncryptedOutcome",
      args: [BigInt(marketId), encryptedOutcome, commitmentHash],
      account: attestor
    });
    await publicClient.waitForTransactionReceipt({ hash: commitTx });
    result.commitTx = commitTx;
    result.commitmentHash = commitmentHash;
    result.evidenceHash = evidenceHash;
    result.mode = mode;
    result.encryptionError = encryptionError;
  }

  market = await readMarket(marketId);
  if (Number(market.state) === MarketState.OUTCOME_COMMITTED) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const commitmentHash = market.outcomeCommitmentHash;
    const digest = keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "uint64" }
        ],
        [CONTRACT_ADDRESS, BigInt(CHAIN_ID), BigInt(marketId), commitmentHash, expiry]
      )
    );
    const signature = await attestor.signMessage({ message: { raw: digest } });

    const triggerTx = await walletA.writeContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "triggerOutcomeDecrypt",
      args: [BigInt(marketId), expiry, signature],
      value: CTX_GAS_PAYMENT,
      account: traderA
    });
    await publicClient.waitForTransactionReceipt({ hash: triggerTx });
    result.triggerTx = triggerTx;
    result.triggerDigest = digest;
    result.triggerExpiry = expiry;

    const proposed = await waitForState(marketId, MarketState.RESOLUTION_PROPOSED, 240_000);
    if (!proposed.reached) {
      throw new Error(
        `Market did not reach RESOLUTION_PROPOSED in time. lastState=${proposed.lastStateCode}`
      );
    }
  }

  market = await readMarket(marketId);
  if (Number(market.state) !== MarketState.RESOLVED) {
    const reasonHash = keccak256(stringToBytes(`override-${Date.now()}`));
    const overrideTx = await walletA.writeContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "overrideResolution",
      args: [BigInt(marketId), Outcome.YES, reasonHash],
      account: traderA
    });
    await publicClient.waitForTransactionReceipt({ hash: overrideTx });
    result.overrideTx = overrideTx;
    result.overrideReasonHash = reasonHash;
  }

  console.log("[settle] outcome commit", result.commitTx, "trigger", result.triggerTx, "override", result.overrideTx);
  return result;
}

async function runClaims(marketId) {
  const claimResult = {
    traderA: { claimed: false, tx: null, skipped: false },
    traderB: { claimed: false, tx: null, skipped: false }
  };

  const [posA, posB] = await Promise.all([
    publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "getPosition",
      args: [BigInt(marketId), traderA.address]
    }),
    publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "getPosition",
      args: [BigInt(marketId), traderB.address]
    })
  ]);

  if (!Boolean(posA.claimed)) {
    const tx = await walletA.writeContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "claimPayout",
      args: [BigInt(marketId)],
      account: traderA
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    claimResult.traderA = { claimed: true, tx, skipped: false };
  } else {
    claimResult.traderA.skipped = true;
  }

  if (!Boolean(posB.claimed)) {
    const tx = await walletB.writeContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "claimPayout",
      args: [BigInt(marketId)],
      account: traderB
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    claimResult.traderB = { claimed: true, tx, skipped: false };
  } else {
    claimResult.traderB.skipped = true;
  }

  console.log("[settle] claim tx A", claimResult.traderA.tx, "B", claimResult.traderB.tx);
  return claimResult;
}

async function readMarket(marketId) {
  return publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "getMarket",
    args: [BigInt(marketId)]
  });
}

async function waitForState(marketId, targetState, timeoutMs) {
  const start = Date.now();
  let lastStateCode = -1;
  while (Date.now() - start < timeoutMs) {
    const market = await readMarket(marketId);
    lastStateCode = Number(market.state);
    if (lastStateCode >= targetState) {
      return { reached: true, lastStateCode };
    }
    await sleep(3000);
  }
  return { reached: false, lastStateCode };
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
  console.log(`[settle] balances ${label}`);
  console.log(
    "  traderA",
    balances.traderA.address,
    "native",
    balances.traderA.native,
    "usdc",
    balances.traderA.usdc
  );
  console.log(
    "  traderB",
    balances.traderB.address,
    "native",
    balances.traderB.native,
    "usdc",
    balances.traderB.usdc
  );
}

function ensurePrivateKey(value, name) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error("[settle:error]", msg);
  process.exit(1);
});
