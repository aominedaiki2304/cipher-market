import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BITE } from "@skalenetwork/bite";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodePacked,
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
import { config } from "./config.js";
import { appendTrace } from "./trace.js";
import {
  signBatchTriggerAttestation,
  signOutcomeRevealAttestation
} from "./attestation.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const DEMO_QUESTIONS = [
  "Fed decision in March?",
  "Will BTC close above $80k this week?",
  "Will ETH gas be under 25 gwei at close?",
  "Will an AI model beat a human at a new benchmark this month?",
  "Will a major L2 ship a critical upgrade before month-end?"
];

function loadMarketAbi() {
  const artifactPath = path.join(
    config.rootDir,
    "artifacts",
    "deployment",
    "private-prediction-market.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing deployment artifact at ${artifactPath}`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!Array.isArray(artifact?.abi)) {
    throw new Error("Deployment artifact missing ABI");
  }
  return artifact.abi;
}

const marketAbi = loadMarketAbi();

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

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  return fallback;
}

function parseOutcome(value) {
  const v = Number(value);
  if ([1, 2, 3].includes(v)) return v;
  return 1;
}

function computeOrdersRoot(orderIds, orders) {
  // Must match `_computeOrdersRoot()` in `PrivatePredictionMarket.sol`.
  let rolling = keccak256("0x"); // keccak256("") in Solidity
  for (let i = 0; i < orderIds.length; i++) {
    const orderId = BigInt(orderIds[i]);
    const order = orders[i];
    rolling = keccak256(
      encodePacked(
        ["bytes32", "uint256", "bytes32", "address"],
        [rolling, orderId, order.commitmentHash, order.trader]
      )
    );
  }
  return rolling;
}

export function startRelayer() {
  const enabled = process.env.RELAYER_ENABLED !== "0";
  if (!enabled) {
    console.log("[relayer] disabled (RELAYER_ENABLED=0)");
    return { stop() {} };
  }

  if (!config.defaultContractAddress) {
    console.log("[relayer] disabled (missing contract address)");
    return { stop() {} };
  }

  if (!config.attestorPrivateKey || config.attestorPrivateKey === "0x") {
    console.log("[relayer] disabled (missing ATTESTOR_PRIVATE_KEY)");
    return { stop() {} };
  }

  const relayerKey =
    process.env.RELAYER_PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    "";

  if (!relayerKey || relayerKey === "0x") {
    console.log("[relayer] disabled (missing RELAYER_PRIVATE_KEY/DEPLOYER_PRIVATE_KEY)");
    return { stop() {} };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKey)) {
    console.log("[relayer] disabled (relayer key invalid format)");
    return { stop() {} };
  }

  const relayerAccount = privateKeyToAccount(relayerKey);
  const intervalMs = parsePositiveInt(process.env.RELAYER_INTERVAL_MS, 8000);
  const scanDepth = parsePositiveInt(process.env.RELAYER_SCAN_DEPTH, 12);
  const attestationExpirySeconds = parsePositiveInt(process.env.RELAYER_ATTEST_EXPIRY_SECONDS, 1800);
  const ctxGasPayment = parseEther(process.env.RELAYER_CTX_GAS_PAYMENT || "0.06");
  const defaultOutcome = parseOutcome(process.env.RELAYER_DEFAULT_OUTCOME);
  const marketCreationEnabled = process.env.RELAYER_MARKET_CREATION_ENABLED !== "0";
  const seedOnStart = process.env.RELAYER_SEED_MARKETS_ON_START !== "0";
  const targetOpenMarkets = parsePositiveInt(process.env.RELAYER_TARGET_OPEN_MARKETS, 4);
  const createIntervalSeconds = parsePositiveInt(process.env.RELAYER_MARKET_CREATE_INTERVAL_SECONDS, 3600);
  const marketDurationSeconds = parsePositiveInt(process.env.RELAYER_MARKET_DURATION_SECONDS, 3600);
  const resolveBufferSeconds = parsePositiveInt(process.env.RELAYER_MARKET_RESOLVE_BUFFER_SECONDS, 3600);
  const disputeWindowSeconds = parsePositiveInt(process.env.RELAYER_MARKET_DISPUTE_WINDOW_SECONDS, 60);
  const orderDepositUnit = parseUnits(process.env.RELAYER_ORDER_DEPOSIT_USDC || "1", 6);
  const maxStakePerOrder = parseUnits(process.env.RELAYER_MAX_STAKE_PER_ORDER_USDC || "1", 6);
  const maxTotalStake = parseUnits(process.env.RELAYER_MAX_TOTAL_STAKE_USDC || "10", 6);
  const createMaxPerTick = parsePositiveInt(process.env.RELAYER_CREATE_MAX_PER_TICK, 2);

  const chain = {
    id: config.chainId,
    name: "SKALE BITE v2 Sandbox",
    nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] }, public: { http: [config.rpcUrl] } }
  };

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl, { retryCount: 2 })
  });
  const walletClient = createWalletClient({
    chain,
    transport: http(config.rpcUrl, { retryCount: 2 }),
    account: relayerAccount
  });

  const attestorAccount = privateKeyToAccount(config.attestorPrivateKey);
  const attestorWalletClient = createWalletClient({
    chain,
    transport: http(config.rpcUrl, { retryCount: 2 }),
    account: attestorAccount
  });

  console.log(
    `[relayer] enabled address=${relayerAccount.address} intervalMs=${intervalMs} scanDepth=${scanDepth} ctxGasPayment=${formatEther(ctxGasPayment)}`
  );

  let stopped = false;
  let inFlight = false;
  let seeded = false;
  let lastMarketCreateAt = 0;
  const noOrderMarkets = new Set();

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;

    try {
      if (!config.attestorAddress) {
        console.log("[relayer] waiting for attestor address (missing ATTESTOR_PRIVATE_KEY?)");
        return;
      }

      const nextMarketId = await publicClient.readContract({
        address: getAddress(config.defaultContractAddress),
        abi: marketAbi,
        functionName: "nextMarketId"
      });
      const latest = Number(nextMarketId - 1n);
      const ts = nowSeconds();

      // Always try to keep a small set of open demo markets available.
      if (marketCreationEnabled) {
        const created = await maybeCreateMarkets({ latest, ts });
        if (created > 0) {
          // Update latest so settlement scan includes newly created markets.
          // Note: The tx receipt is awaited in `handleCreateMarket()`, so reads should succeed next tick too.
        }
      }

      if (!Number.isFinite(latest) || latest <= 0) {
        return;
      }

      const start = Math.max(1, latest - scanDepth + 1);
      for (let marketId = latest; marketId >= start; marketId--) {
        const market = await publicClient.readContract({
          address: getAddress(config.defaultContractAddress),
          abi: marketAbi,
          functionName: "getMarket",
          args: [BigInt(marketId)]
        });

        const state = Number(market.state);

        if (state === MarketState.OPEN && ts >= Number(market.closeTime)) {
          await handleBatchDecrypt({ marketId, ctxGasPayment, attestationExpirySeconds });
          // Give the chain a moment to process CTX callback (next block).
          await sleep(1500);
          continue;
        }

        if (state === MarketState.BATCH_PROCESSED) {
          const commit = await handleCommitOutcome({
            marketId,
            outcome: defaultOutcome
          });
          await handleTriggerOutcomeDecrypt({
            marketId,
            commitmentHash: commit.commitmentHash,
            ctxGasPayment,
            attestationExpirySeconds
          });
          await sleep(1500);
          continue;
        }

        if (state === MarketState.OUTCOME_COMMITTED) {
          await handleTriggerOutcomeDecrypt({
            marketId,
            commitmentHash: market.outcomeCommitmentHash,
            ctxGasPayment,
            attestationExpirySeconds
          });
          await sleep(1500);
          continue;
        }

        if (state === MarketState.OUTCOME_CTX_REQUESTED) {
          // Waiting for CTX callback to propose resolution.
          continue;
        }

        if (state === MarketState.RESOLUTION_PROPOSED) {
          if (ts > Number(market.disputeDeadline)) {
            await handleFinalizeResolution({ marketId });
          }
          continue;
        }

        if (state === MarketState.IN_DISPUTE) {
          // Requires approver override; relayer deliberately does nothing.
          continue;
        }

        if (state === MarketState.ORDER_CTX_REQUESTED) {
          // If someone else triggered without paying the CTX sender, this market can get stuck.
          // We do not attempt to "rescue" it automatically; it's safer to just create a new demo market.
          continue;
        }

        if (state === MarketState.RESOLVED || state === MarketState.CANCELLED) {
          continue;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      appendTrace("relayer_error", { error: msg });
      console.log("[relayer] tick error:", msg);
    } finally {
      inFlight = false;
    }
  }

  async function maybeCreateMarkets({ latest, ts }) {
    if (!seeded && seedOnStart) {
      // On startup, seed a small set of open markets immediately for demo UX.
      const openCount = await countActiveOpenMarkets({ latest, ts });
      const missing = Math.max(0, targetOpenMarkets - openCount);
      const toCreate = missing;
      let created = 0;
      for (let i = 0; i < toCreate; i++) {
        await handleCreateMarket({ latest, ts, indexOffset: i });
        created++;
      }
      seeded = true;
      if (created > 0) {
        lastMarketCreateAt = ts;
      }
      return created;
    }

    const effectiveMinInterval = Math.min(
      createIntervalSeconds,
      Math.max(15, Math.floor(marketDurationSeconds / Math.max(1, targetOpenMarkets)))
    );

    if (ts - lastMarketCreateAt < effectiveMinInterval) {
      return 0;
    }

    const openCount = await countActiveOpenMarkets({ latest, ts });
    if (openCount >= targetOpenMarkets) {
      return 0;
    }

    const missing = targetOpenMarkets - openCount;
    const toCreate = Math.min(missing, Math.max(1, createMaxPerTick));
    let created = 0;
    for (let i = 0; i < toCreate; i++) {
      await handleCreateMarket({ latest, ts, indexOffset: i });
      created++;
    }
    if (created > 0) {
      lastMarketCreateAt = ts;
    }
    return created;
  }

  async function countActiveOpenMarkets({ latest, ts }) {
    if (!Number.isFinite(latest) || latest <= 0) return 0;
    const start = Math.max(1, latest - scanDepth + 1);
    let openCount = 0;
    for (let marketId = latest; marketId >= start; marketId--) {
      const market = await publicClient
        .readContract({
          address: getAddress(config.defaultContractAddress),
          abi: marketAbi,
          functionName: "getMarket",
          args: [BigInt(marketId)]
        })
        .catch(() => null);
      if (!market) continue;
      const state = Number(market.state);
      if (state !== MarketState.OPEN) continue;
      if (ts >= Number(market.closeTime)) continue;
      openCount++;
    }
    return openCount;
  }

  async function handleCreateMarket({ latest, ts, indexOffset }) {
    const contractAddress = getAddress(config.defaultContractAddress);

    const questionBase = DEMO_QUESTIONS[(Math.max(0, latest) + indexOffset) % DEMO_QUESTIONS.length];
    const question = `${questionBase} [demo ${new Date(ts * 1000).toISOString()}]`;
    const questionHash = keccak256(stringToBytes(question));
    const metadataHash = keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "uint256" }],
        [question, BigInt(ts)]
      )
    );

    const spacing = Math.max(15, Math.min(300, Math.floor(marketDurationSeconds / Math.max(1, targetOpenMarkets))));
    const openTime = ts - 60;
    const closeTime = ts + marketDurationSeconds + (indexOffset * spacing);
    const resolveBy = closeTime + resolveBufferSeconds;

    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: marketAbi,
      functionName: "createMarket",
      args: [
        {
          collateralToken: getAddress(config.collateralToken),
          questionHash,
          metadataHash,
          openTime,
          closeTime,
          resolveBy,
          orderDepositUnit,
          maxStakePerOrder,
          maxTotalStake,
          attestor: getAddress(config.attestorAddress),
          approver: relayerAccount.address,
          disputeWindowSeconds,
          allowlistEnabled: false,
          allowlist: []
        }
      ],
      account: relayerAccount
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const nextMarketId = await publicClient.readContract({
      address: contractAddress,
      abi: marketAbi,
      functionName: "nextMarketId"
    });
    const marketId = Number(nextMarketId - 1n);

    appendTrace("relayer_market_created", {
      marketId,
      question,
      openTime,
      closeTime,
      resolveBy,
      depositUsdc: formatUnits(orderDepositUnit, 6),
      maxStakePerOrderUsdc: formatUnits(maxStakePerOrder, 6),
      maxTotalStakeUsdc: formatUnits(maxTotalStake, 6),
      caller: relayerAccount.address,
      txHash
    });

    console.log("[relayer] created market", marketId, "tx", txHash);
  }

  async function handleBatchDecrypt({ marketId, ctxGasPayment, attestationExpirySeconds }) {
    if (noOrderMarkets.has(marketId)) {
      return;
    }
    const contractAddress = getAddress(config.defaultContractAddress);

    const orderIds = await publicClient.readContract({
      address: contractAddress,
      abi: marketAbi,
      functionName: "getMarketOrderIds",
      args: [BigInt(marketId)]
    });
    const ids = Array.isArray(orderIds) ? orderIds.map((x) => Number(x)).filter((n) => n > 0) : [];

    if (ids.length === 0) {
      appendTrace("relayer_batch_skipped", { marketId, reason: "no_orders" });
      noOrderMarkets.add(marketId);
      return;
    }

    const [nextBatchId, orders] = await Promise.all([
      publicClient.readContract({
        address: contractAddress,
        abi: marketAbi,
        functionName: "nextBatchId"
      }),
      Promise.all(
        ids.map((id) =>
          publicClient.readContract({
            address: contractAddress,
            abi: marketAbi,
            functionName: "getOrder",
            args: [BigInt(id)]
          })
        )
      )
    ]);

    // If any order is missing a commitment or trader, skip.
    for (let i = 0; i < orders.length; i++) {
      if (!orders[i] || orders[i].commitmentHash === "0x" || orders[i].trader === ZERO_ADDRESS) {
        appendTrace("relayer_batch_skipped", { marketId, reason: "invalid_order_view", orderId: ids[i] });
        return;
      }
    }

    const ordersRoot = computeOrdersRoot(ids, orders);
    const batchId = Number(nextBatchId);
    const expiry = nowSeconds() + attestationExpirySeconds;

    const attestation = await signBatchTriggerAttestation({
      contractAddress,
      chainId: config.chainId,
      marketId,
      batchId,
      ordersRoot,
      expiry
    });

    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: marketAbi,
      functionName: "triggerBatchDecrypt",
      args: [
        BigInt(marketId),
        ids.map((id) => BigInt(id)),
        {
          batchId: BigInt(batchId),
          expiry: BigInt(expiry),
          ordersRoot
        },
        attestation.signature
      ],
      value: ctxGasPayment,
      account: relayerAccount
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });

    appendTrace("relayer_batch_triggered", {
      marketId,
      batchId,
      orderCount: ids.length,
      ordersRoot,
      digest: attestation.digest,
      signature: attestation.signature,
      caller: relayerAccount.address,
      valueEth: formatEther(ctxGasPayment),
      txHash
    });
  }

  const outcomeArgs = parseAbiParameters("uint256 marketId, uint8 outcome, bytes32 evidenceHash, uint256 nonce");

  async function handleCommitOutcome({ marketId, outcome }) {
    const contractAddress = getAddress(config.defaultContractAddress);
    const ts = nowSeconds();
    const evidenceHash = keccak256(stringToBytes(`ciphermarket-outcome-${marketId}-${ts}`));
    const nonce = BigInt(Date.now());

    const encoded = encodeAbiParameters(outcomeArgs, [
      BigInt(marketId),
      Number(outcome),
      evidenceHash,
      nonce
    ]);
    const commitmentHash = keccak256(encoded);

    let encryptedOutcome = encoded;
    let mode = "simulated";
    let encryptionError = null;
    try {
      const bite = new BITE(config.rpcUrl);
      encryptedOutcome = await bite.encryptMessage(encoded);
      mode = "bite-v2";
    } catch (error) {
      encryptionError = error instanceof Error ? error.message : "Unknown encryption error";
    }

    const txHash = await attestorWalletClient.writeContract({
      address: contractAddress,
      abi: marketAbi,
      functionName: "commitEncryptedOutcome",
      args: [BigInt(marketId), encryptedOutcome, commitmentHash],
      account: attestorAccount
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    appendTrace("relayer_outcome_committed", {
      marketId,
      outcome,
      evidenceHash,
      commitmentHash,
      mode,
      encryptionError,
      caller: attestorAccount.address,
      txHash
    });

    return { commitmentHash, evidenceHash, txHash };
  }

  async function handleTriggerOutcomeDecrypt({
    marketId,
    commitmentHash,
    ctxGasPayment,
    attestationExpirySeconds
  }) {
    const contractAddress = getAddress(config.defaultContractAddress);
    const expiry = nowSeconds() + attestationExpirySeconds;

    const attestation = await signOutcomeRevealAttestation({
      contractAddress,
      chainId: config.chainId,
      marketId,
      commitmentHash,
      expiry
    });

    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: marketAbi,
      functionName: "triggerOutcomeDecrypt",
      args: [BigInt(marketId), BigInt(expiry), attestation.signature],
      value: ctxGasPayment,
      account: relayerAccount
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });

    appendTrace("relayer_outcome_decrypt_triggered", {
      marketId,
      commitmentHash,
      expiry,
      digest: attestation.digest,
      signature: attestation.signature,
      caller: relayerAccount.address,
      valueEth: formatEther(ctxGasPayment),
      txHash
    });
  }

  async function handleFinalizeResolution({ marketId }) {
    const contractAddress = getAddress(config.defaultContractAddress);
    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: marketAbi,
      functionName: "finalizeResolution",
      args: [BigInt(marketId)],
      account: relayerAccount
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    appendTrace("relayer_resolution_finalized", {
      marketId,
      caller: relayerAccount.address,
      txHash
    });
  }

  const timer = setInterval(tick, intervalMs);
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
