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
  encodePacked,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbiParameters,
  parseEther,
  parseEventLogs,
  parseUnits,
  stringToBytes
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });

const DEFAULT_RPC = "https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox";
const DEFAULT_CHAIN_ID = 103698795;
const DEFAULT_USDC = "0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8";

const RPC_URL = process.env.RPC_URL || DEFAULT_RPC;
const CHAIN_ID = Number(process.env.CHAIN_ID || DEFAULT_CHAIN_ID);
const CONTRACT_ADDRESS = getAddress(process.env.PRIVATE_PREDICTION_MARKET_ADDRESS || "");
const USDC_ADDRESS = getAddress(process.env.USDC_ADDRESS || DEFAULT_USDC);

const deployer = privateKeyToAccount(mustPk(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY"));
const attestor = privateKeyToAccount(mustPk(process.env.ATTESTOR_PRIVATE_KEY, "ATTESTOR_PRIVATE_KEY"));

const traderA = privateKeyToAccount(mustPk(process.env.TRADER_A, "TRADER_A"));
const traderB = privateKeyToAccount(mustPk(process.env.TRADER_B, "TRADER_B"));
const traderC = privateKeyToAccount(mustPk(process.env.TRADER_C, "TRADER_C"));
const traderD = privateKeyToAccount(mustPk(process.env.TRADER_D, "TRADER_D"));
const traderE = privateKeyToAccount(mustPk(process.env.TRADER_E, "TRADER_E"));

const chain = {
  id: CHAIN_ID,
  name: "SKALE BITE v2 Sandbox",
  nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } }
};

const transport = http(RPC_URL, { retryCount: 5, retryDelay: 1_000, timeout: 15_000 });
const publicClient = createPublicClient({ chain, transport });

const walletA = createWalletClient({ chain, transport, account: traderA });
const walletB = createWalletClient({ chain, transport, account: traderB });
const walletC = createWalletClient({ chain, transport, account: traderC });
const walletD = createWalletClient({ chain, transport, account: traderD });
const walletE = createWalletClient({ chain, transport, account: traderE });
const walletDeployer = createWalletClient({ chain, transport, account: deployer });
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
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
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

const orderArgs = parseAbiParameters(
  "address trader, uint8 side, uint256 maxCost, uint16 limitPriceBps, uint256 nonce"
);
const outcomeArgs = parseAbiParameters("uint256 marketId, uint8 outcome, bytes32 evidenceHash, uint256 nonce");

const CTX_GAS_PAYMENT = parseEther(process.env.CTX_GAS_PAYMENT || "0.06");

// Test tuning knobs.
// Goal: keep CTX mechanics identical, but reduce "market open" wait time and fail fast if CTX never finalizes.
// NOTE: In practice, the CTX callback can revert if the batch includes too many encrypted args.
// Keep batches small (<= 5) in tests to stay within current sandbox limits.
const EDGE_CLOSE_DELAY_S1_SECONDS = envInt("EDGE_CLOSE_DELAY_S1_SECONDS", 45, { min: 30, max: 600 });
const EDGE_CLOSE_DELAY_S2_SECONDS = envInt("EDGE_CLOSE_DELAY_S2_SECONDS", 30, { min: 20, max: 600 });
const EDGE_RESOLVE_BUFFER_SECONDS = envInt("EDGE_RESOLVE_BUFFER_SECONDS", 600, { min: 120, max: 86_400 });
const EDGE_DISPUTE_WINDOW_SECONDS = envInt("EDGE_DISPUTE_WINDOW_SECONDS", 15, { min: 1, max: 3_600 });
const EDGE_CTX_TIMEOUT_MS = envInt("EDGE_CTX_TIMEOUT_MS", 150_000, { min: 60_000, max: 900_000 });
const EDGE_POLL_INTERVAL_MS = envInt("EDGE_POLL_INTERVAL_MS", 2_000, { min: 1_000, max: 15_000 });
const EDGE_WAIT_AFTER_CLOSE_SECONDS = envInt("EDGE_WAIT_AFTER_CLOSE_SECONDS", 3, { min: 0, max: 30 });
const EDGE_SKIP_FUNDING = process.env.EDGE_SKIP_FUNDING === "1";
const EDGE_SKIP_APPROVALS = process.env.EDGE_SKIP_APPROVALS === "1";
const EDGE_CONCURRENCY = envInt("EDGE_CONCURRENCY", 3, { min: 1, max: 8 });
// Lower deposit makes fast-mode tests reliable even if traders have partially locked funds from prior runs.
const EDGE_ORDER_DEPOSIT_USDC = envInt("EDGE_ORDER_DEPOSIT_USDC", 1, { min: 1, max: 10_000 });
const EDGE_MAX_TOTAL_STAKE_USDC = envInt("EDGE_MAX_TOTAL_STAKE_USDC", 500, { min: 10, max: 1_000_000 });
const EDGE_RUN_EXTRA = process.env.EDGE_RUN_EXTRA === "1";

const ReasonCode = {
  NONE: 0,
  INVALID_SIDE: 5,
  MAX_COST_OVER_LIMIT: 6,
  TRADER_MISMATCH: 13,
  COMMITMENT_MISMATCH: 15,
  INVALID_LIMIT_PRICE: 16,
  LIMIT_NOT_MET: 17,
  UNMATCHED: 18
};

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[edge-tests:error] ${message}`);
  process.exit(1);
});

async function main() {
  if (!CONTRACT_ADDRESS || CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000") {
    throw new Error("PRIVATE_PREDICTION_MARKET_ADDRESS missing/invalid in .env");
  }

  console.log("[edge-tests] rpc", RPC_URL);
  console.log("[edge-tests] chainId", CHAIN_ID);
  console.log("[edge-tests] contract", CONTRACT_ADDRESS);
  console.log("[edge-tests] usdc", USDC_ADDRESS);

  const accounts = [
    { name: "TRADER_A", account: traderA, wallet: walletA },
    { name: "TRADER_B", account: traderB, wallet: walletB },
    { name: "TRADER_C", account: traderC, wallet: walletC },
    { name: "TRADER_D", account: traderD, wallet: walletD },
    { name: "TRADER_E", account: traderE, wallet: walletE }
  ];

  if (!EDGE_SKIP_FUNDING) {
    console.log("[edge-tests] ensuring funding for traders (native + USDC)...");
    await ensureFunding(accounts);
  } else {
    console.log("[edge-tests] skipping funding checks (EDGE_SKIP_FUNDING=1)");
  }
  if (!EDGE_SKIP_APPROVALS) {
    console.log("[edge-tests] ensuring USDC allowances to contract...");
    await ensureAllowances(accounts);
  } else {
    console.log("[edge-tests] skipping USDC approvals (EDGE_SKIP_APPROVALS=1)");
  }
  console.log("[edge-tests] running scenario 1 (sealed limit batch + confidential outcome)...");

  const report = {
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    contractAddress: CONTRACT_ADDRESS,
    scenarios: []
  };

  report.scenarios.push(await scenarioBatchClearingAndResolution(accounts));
  if (EDGE_RUN_EXTRA) {
    console.log("[edge-tests] running extra rejection-reasons scenario (EDGE_RUN_EXTRA=1)...");
    report.scenarios.push(await scenarioAdditionalBatchRejectionReasons(accounts));
  }
  console.log("[edge-tests] running scenario 2 (unmatched all-YES batch)...");
  report.scenarios.push(await scenarioUnmatchedAllYes(accounts));

  const outPath = path.join(root, "artifacts", "traces", "five-trader-edge-tests.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("[edge-tests] wrote", outPath);
  console.log("[edge-tests] scenarios:", report.scenarios.map((s) => `${s.name}:${s.ok ? "ok" : "FAIL"}`).join(", "));
}

async function ensureFunding(accounts) {
  const minNative = parseEther(process.env.TRADER_MIN_NATIVE || "0.02");
  const minUsdc = parseUnits(process.env.TRADER_TARGET_USDC || "100", 6);

  for (const a of accounts) {
    console.log(`[edge-tests] funding check ${a.name} ${a.account.address}`);
    const native = await rpc(() => publicClient.getBalance({ address: a.account.address }), "getBalance");
    if (native < minNative) {
      const delta = minNative - native;
      const hash = await rpc(
        () =>
          walletDeployer.sendTransaction({
            account: deployer,
            to: a.account.address,
            value: delta
          }),
        "fundNative"
      );
      await rpc(() => publicClient.waitForTransactionReceipt({ hash }), "waitNativeTopup");
      console.log(`[edge-tests] topped native ${a.name} +${formatEther(delta)}`);
    }

    const usdc = await rpc(
      () =>
        publicClient.readContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [a.account.address]
        }),
      "balanceOf"
    );
    if (usdc < minUsdc) {
      const delta = minUsdc - usdc;
      const hash = await rpc(
        () =>
          walletDeployer.writeContract({
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: "transfer",
            args: [a.account.address, delta]
          }),
        "fundUsdc"
      );
      await rpc(() => publicClient.waitForTransactionReceipt({ hash }), "waitUsdcTopup");
      console.log(`[edge-tests] topped usdc ${a.name} +${formatUnits(delta, 6)}`);
    }
  }
}

async function ensureAllowances(accounts) {
  const max = (1n << 256n) - 1n;
  // Approvals can be done in parallel (one tx per wallet) to shorten test runtime.
  await mapLimit(
    accounts,
    EDGE_CONCURRENCY,
    async (a) => {
      console.log(`[edge-tests] approving USDC for ${a.name}...`);
      const hash = await rpc(
        () =>
          a.wallet.writeContract({
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [CONTRACT_ADDRESS, max]
          }),
        `approve-${a.name}`
      );
      await rpc(() => publicClient.waitForTransactionReceipt({ hash }), `waitApprove-${a.name}`);
    }
  );
}

async function scenarioBatchClearingAndResolution(accounts) {
  const name = "sealed-limit-batch-and-confidential-resolution";
  const scenario = {
    name,
    ok: false,
    marketId: null,
    orderIds: {},
    checks: []
  };

  const now = await chainNow();
  const question = `edge-batch-${now}`;
  const questionHash = keccak256(stringToBytes(question));
  const metadataHash = keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [question, BigInt(now)])
  );

  const orderDepositUnit = parseUnits(String(EDGE_ORDER_DEPOSIT_USDC), 6);
  const maxStakePerOrder = orderDepositUnit;
  const maxTotalStake = parseUnits(String(EDGE_MAX_TOTAL_STAKE_USDC), 6);

  const closeTime = now + EDGE_CLOSE_DELAY_S1_SECONDS;
  const resolveBy = closeTime + EDGE_RESOLVE_BUFFER_SECONDS;

  const createHash = await rpc(
    () =>
      walletA.writeContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "createMarket",
        args: [
          {
            collateralToken: USDC_ADDRESS,
            questionHash,
            metadataHash,
            openTime: now - 30,
            closeTime,
            resolveBy,
            orderDepositUnit,
            maxStakePerOrder,
            maxTotalStake,
            attestor: attestor.address,
            approver: traderA.address,
            disputeWindowSeconds: EDGE_DISPUTE_WINDOW_SECONDS,
            allowlistEnabled: false,
            allowlist: []
          }
        ]
      }),
    "createMarket"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash: createHash }), "waitCreateMarket");

  const nextMarketId = await rpc(
    () =>
      publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "nextMarketId"
      }),
    "nextMarketId"
  );
  const marketId = Number(nextMarketId - 1n);
  scenario.marketId = marketId;

  // Build + submit orders. Note: encryptor uses BITE; commitmentHash must match plaintext.
  const bite = new BITE(RPC_URL);

  const submit = async ({ label, wallet, from, trader, side, maxCost, limitPriceBps, nonce, overrideCommitment }) => {
    const encoded = encodeAbiParameters(orderArgs, [
      getAddress(trader),
      Number(side),
      BigInt(maxCost),
      Number(limitPriceBps),
      BigInt(nonce)
    ]);
    const commitmentHash = overrideCommitment ?? keccak256(encoded);
    const encrypted = await biteEncrypt(bite, encoded);

    const hash = await rpc(
      () =>
        wallet.writeContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "submitEncryptedOrder",
          args: [BigInt(marketId), encrypted, commitmentHash],
          account: from
        }),
      `submit-${label}`
    );
    return { label, hash };
  };

  // Submit 5 orders in parallel (1 per wallet) to ensure we beat closeTime.
  const submissions = await Promise.all([
    // Valid base orders (target clearing 6000 / matched 1000 lots).
    submit({
      label: "O1_valid_yes_A",
      wallet: walletA,
      from: traderA,
      trader: traderA.address,
      side: 1,
      maxCost: parseUnits("0.6", 6),
      limitPriceBps: 10_000,
      nonce: 1
    }),
    submit({
      label: "O2_valid_no_B",
      wallet: walletB,
      from: traderB,
      trader: traderB.address,
      side: 2,
      maxCost: parseUnits("0.4", 6),
      limitPriceBps: 10_000,
      nonce: 2
    }),
    // Commitment mismatch -> reject.
    submit({
      label: "O3_commitment_mismatch_C",
      wallet: walletC,
      from: traderC,
      trader: traderC.address,
      side: 2,
      maxCost: parseUnits("0.5", 6),
      limitPriceBps: 10_000,
      nonce: 3,
      overrideCommitment: keccak256(stringToBytes("wrong-commitment"))
    }),
    // Trader mismatch -> reject.
    submit({
      label: "O4_trader_mismatch_D",
      wallet: walletD,
      from: traderD,
      trader: traderE.address,
      side: 2,
      maxCost: parseUnits("0.5", 6),
      limitPriceBps: 10_000,
      nonce: 4
    }),
    // Limit not met -> refunded at clearing.
    submit({
      label: "O5_limit_not_met_E",
      wallet: walletE,
      from: traderE,
      trader: traderE.address,
      side: 1,
      maxCost: parseUnits("0.1", 6),
      limitPriceBps: 5_000,
      nonce: 5
    })
  ]);

  // Collect orderIds from receipts (parallel wait).
  await mapLimit(
    submissions,
    EDGE_CONCURRENCY,
    async (s) => {
      const receipt = await rpc(() => publicClient.waitForTransactionReceipt({ hash: s.hash }), `wait-${s.label}`);
      const logs = parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: "OrderSubmitted" });
      const orderId = Number(logs?.[0]?.args?.orderId ?? 0);
      if (!orderId) throw new Error(`missing OrderSubmitted for ${s.label}`);
      scenario.orderIds[s.label] = orderId;
    }
  );

  const orderIds = Object.values(scenario.orderIds).map((v) => BigInt(v));

  const market = await rpc(() => readMarket(marketId), "readMarket");

  // Wait for closeTime.
  const chainTs2 = await chainNow();
  if (chainTs2 < Number(market.closeTime)) {
    await sleep((Number(market.closeTime) - chainTs2 + EDGE_WAIT_AFTER_CLOSE_SECONDS) * 1000);
  }

  const nextBatchId = await rpc(() => readNextBatchId(), "nextBatchId2");
  const orderViews = await readOrders(orderIds);
  const ordersRoot = computeOrdersRoot(orderIds, orderViews);
  const expiry = BigInt((await chainNow()) + 1800);

  // Negative cases via eth_call simulation (much faster than sending failed transactions).
  const wrongSig = await traderA.signMessage({ message: { raw: batchDigest(marketId, nextBatchId, ordersRoot, expiry) } });
  const wrongSigner = await expectRevertSimulate(async () => {
    await publicClient.simulateContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "triggerBatchDecrypt",
      args: [BigInt(marketId), orderIds, { batchId: nextBatchId, expiry, ordersRoot }, wrongSig],
      value: CTX_GAS_PAYMENT,
      account: traderA.address
    });
  });
  scenario.checks.push({ name: "batch_trigger_wrong_signer_reverts", ok: wrongSigner.ok });

  const expired = BigInt(Math.floor(Date.now() / 1000) - 1);
  const expiredSig = await attestor.signMessage({ message: { raw: batchDigest(marketId, nextBatchId, ordersRoot, expired) } });
  const expiredCheck = await expectRevertSimulate(async () => {
    await publicClient.simulateContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "triggerBatchDecrypt",
      args: [BigInt(marketId), orderIds, { batchId: nextBatchId, expiry: expired, ordersRoot }, expiredSig],
      value: CTX_GAS_PAYMENT,
      account: traderA.address
    });
  });
  scenario.checks.push({ name: "batch_trigger_expired_reverts", ok: expiredCheck.ok });

  const wrongRoot = flipOneBit(ordersRoot);
  const wrongRootSig = await attestor.signMessage({ message: { raw: batchDigest(marketId, nextBatchId, wrongRoot, expiry) } });
  const wrongRootCheck = await expectRevertSimulate(async () => {
    await publicClient.simulateContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "triggerBatchDecrypt",
      args: [BigInt(marketId), orderIds, { batchId: nextBatchId, expiry, ordersRoot: wrongRoot }, wrongRootSig],
      value: CTX_GAS_PAYMENT,
      account: traderA.address
    });
  });
  scenario.checks.push({ name: "batch_trigger_wrong_root_reverts", ok: wrongRootCheck.ok });

  // Correct trigger.
  const digest = batchDigest(marketId, nextBatchId, ordersRoot, expiry);
  const signature = await attestor.signMessage({ message: { raw: digest } });
  const triggerHash = await rpc(
    () =>
      walletA.writeContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "triggerBatchDecrypt",
        args: [BigInt(marketId), orderIds, { batchId: nextBatchId, expiry, ordersRoot }, signature],
        value: CTX_GAS_PAYMENT
      }),
    "triggerBatchDecrypt"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash: triggerHash }), "waitTriggerBatch");

  const processed = await waitForMarketState(marketId, 3 /* BATCH_PROCESSED */, EDGE_CTX_TIMEOUT_MS);
  scenario.checks.push({ name: "batch_processed", ok: processed.reached, lastState: processed.lastState });
  if (!processed.reached) return scenario;

  const afterBatch = await rpc(() => readMarket(marketId), "readMarketAfterBatch");
  scenario.checks.push({
    name: "clearing_price_expected_6000",
    ok: Number(afterBatch.clearingYesPriceBps) === 6000
  });

  const expected = {
    O3_commitment_mismatch_C: ReasonCode.COMMITMENT_MISMATCH,
    O4_trader_mismatch_D: ReasonCode.TRADER_MISMATCH,
    O5_limit_not_met_E: ReasonCode.LIMIT_NOT_MET
  };

  for (const [label, orderId] of Object.entries(scenario.orderIds)) {
    const order = await rpc(
      () =>
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "getOrder",
          args: [BigInt(orderId)]
        }),
      `getOrder-${label}`
    );
    const receipt = await rpc(
      () =>
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "getReceipt",
          args: [order.lastReceiptId]
        }),
      `getReceipt-${label}`
    );

    if (label in expected) {
      scenario.checks.push({
        name: `reason_${label}`,
        ok: Number(receipt.reasonCode) === expected[label]
      });
    }

    if (label === "O1_valid_yes_A") {
      scenario.checks.push({ name: "order1_filled", ok: Number(order.filledLots) === 100 });
    }
    if (label === "O2_valid_no_B") {
      scenario.checks.push({ name: "order2_filled", ok: Number(order.filledLots) === 100 });
    }
  }

  // Claim before resolved should revert.
  const claimEarly = await expectRevertSimulate(async () => {
    await publicClient.simulateContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "claimPayout",
      args: [BigInt(marketId)],
      account: traderA.address
    });
  });
  scenario.checks.push({ name: "claim_before_resolved_reverts", ok: claimEarly.ok });

  // Commit encrypted outcome (attestor).
  const evidenceHash = keccak256(stringToBytes(`edge-outcome-${Date.now()}`));
  const encodedOutcome = encodeAbiParameters(outcomeArgs, [BigInt(marketId), 1, evidenceHash, BigInt(Date.now())]);
  const outcomeCommitment = keccak256(encodedOutcome);
  const encryptedOutcome = await biteEncrypt(bite, encodedOutcome);

  const commitHash = await rpc(
    () =>
      walletAttestor.writeContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "commitEncryptedOutcome",
        args: [BigInt(marketId), encryptedOutcome, outcomeCommitment]
      }),
    "commitOutcome"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash: commitHash }), "waitCommitOutcome");

  // Unauthorized commit should revert.
  const unauthorizedCommit = await expectRevertSimulate(async () => {
    await publicClient.simulateContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "commitEncryptedOutcome",
      args: [BigInt(marketId), encryptedOutcome, outcomeCommitment],
      account: traderA.address
    });
  });
  scenario.checks.push({ name: "commit_outcome_unauthorized_reverts", ok: unauthorizedCommit.ok });

  // Outcome decrypt: wrong signature should revert, then correct should proceed.
  const outcomeExpiry = BigInt((await chainNow()) + 1800);
  const outcomeDigest = outcomeRevealDigest(marketId, outcomeCommitment, outcomeExpiry);
  const badOutcomeSig = await traderA.signMessage({ message: { raw: outcomeDigest } });
  const badOutcome = await expectRevertSimulate(async () => {
    await publicClient.simulateContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "triggerOutcomeDecrypt",
      args: [BigInt(marketId), outcomeExpiry, badOutcomeSig],
      value: CTX_GAS_PAYMENT,
      account: traderA.address
    });
  });
  scenario.checks.push({ name: "outcome_trigger_wrong_signer_reverts", ok: badOutcome.ok });

  const goodOutcomeSig = await attestor.signMessage({ message: { raw: outcomeDigest } });
  const triggerOutcomeHash = await rpc(
    () =>
      walletA.writeContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "triggerOutcomeDecrypt",
        args: [BigInt(marketId), outcomeExpiry, goodOutcomeSig],
        value: CTX_GAS_PAYMENT
      }),
    "triggerOutcomeDecrypt"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash: triggerOutcomeHash }), "waitTriggerOutcome");

  const proposed = await waitForMarketState(marketId, 6 /* RESOLUTION_PROPOSED */, EDGE_CTX_TIMEOUT_MS);
  scenario.checks.push({ name: "resolution_proposed", ok: proposed.reached, lastState: proposed.lastState });
  if (!proposed.reached) return scenario;

  const overrideHash = await rpc(
    () =>
      walletA.writeContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "overrideResolution",
        args: [BigInt(marketId), 1, keccak256(stringToBytes(`override-${Date.now()}`))]
      }),
    "overrideResolution"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash: overrideHash }), "waitOverride");

  const resolved = await waitForMarketState(marketId, 8 /* RESOLVED */, EDGE_CTX_TIMEOUT_MS);
  scenario.checks.push({ name: "resolved", ok: resolved.reached });
  if (!resolved.reached) return scenario;

  const balancesBefore = await readUsdcBalances(accounts);

  for (const a of accounts) {
    const claimHash = await rpc(
      () =>
        a.wallet.writeContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "claimPayout",
          args: [BigInt(marketId)]
        }),
      `claim-${a.name}`
    );
    await rpc(() => publicClient.waitForTransactionReceipt({ hash: claimHash }), `waitClaim-${a.name}`);
  }

  const balancesAfter = await readUsdcBalances(accounts);
  const deltas = {};
  for (const a of accounts) {
    deltas[a.name] = Number(formatUnits(balancesAfter[a.name] - balancesBefore[a.name], 6));
  }

  // Expected claim payouts (USDC).
  // With orderDepositUnit=1:
  // A: YES wins => refundable 0.4 + winnings 1.0 = 1.4
  // B: NO loses => refundable 0.6
  // C/D/E: fully refunded 1.0
  scenario.checks.push({ name: "claim_delta_TRADER_A", ok: closeTo(deltas.TRADER_A, 1.4) });
  scenario.checks.push({ name: "claim_delta_TRADER_B", ok: closeTo(deltas.TRADER_B, 0.6) });
  scenario.checks.push({ name: "claim_delta_TRADER_C", ok: closeTo(deltas.TRADER_C, 1.0) });
  scenario.checks.push({ name: "claim_delta_TRADER_D", ok: closeTo(deltas.TRADER_D, 1.0) });
  scenario.checks.push({ name: "claim_delta_TRADER_E", ok: closeTo(deltas.TRADER_E, 1.0) });

  // Double-claim should revert.
  const doubleClaim = await expectRevertSimulate(async () => {
    await publicClient.simulateContract({
      address: CONTRACT_ADDRESS,
      abi: marketAbi,
      functionName: "claimPayout",
      args: [BigInt(marketId)],
      account: traderA.address
    });
  });
  scenario.checks.push({ name: "double_claim_reverts", ok: doubleClaim.ok });

  scenario.ok = scenario.checks.every((c) => c.ok);
  return scenario;
}

async function scenarioAdditionalBatchRejectionReasons(accounts) {
  const name = "sealed-batch-additional-rejection-reasons";
  const scenario = {
    name,
    ok: false,
    marketId: null,
    orderIds: {},
    checks: []
  };

  const now = await chainNow();
  const question = `edge-rejections-${now}`;
  const questionHash = keccak256(stringToBytes(question));
  const metadataHash = keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [question, BigInt(now)])
  );

  const orderDepositUnit = parseUnits(String(EDGE_ORDER_DEPOSIT_USDC), 6);
  const maxStakePerOrder = orderDepositUnit;
  const maxTotalStake = parseUnits(String(EDGE_MAX_TOTAL_STAKE_USDC), 6);

  const closeTime = now + EDGE_CLOSE_DELAY_S1_SECONDS;
  const resolveBy = closeTime + EDGE_RESOLVE_BUFFER_SECONDS;

  const createHash = await rpc(
    () =>
      walletA.writeContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "createMarket",
        args: [
          {
            collateralToken: USDC_ADDRESS,
            questionHash,
            metadataHash,
            openTime: now - 30,
            closeTime,
            resolveBy,
            orderDepositUnit,
            maxStakePerOrder,
            maxTotalStake,
            attestor: attestor.address,
            approver: traderA.address,
            disputeWindowSeconds: EDGE_DISPUTE_WINDOW_SECONDS,
            allowlistEnabled: false,
            allowlist: []
          }
        ]
      }),
    "createMarket-rejections"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash: createHash }), "waitCreateMarket-rejections");

  const nextMarketId = await rpc(
    () =>
      publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "nextMarketId"
      }),
    "nextMarketId-rejections"
  );
  const marketId = Number(nextMarketId - 1n);
  scenario.marketId = marketId;

  const bite = new BITE(RPC_URL);

  const submit = async ({ label, wallet, from, trader, side, maxCost, limitPriceBps, nonce, overrideCommitment }) => {
    const encoded = encodeAbiParameters(orderArgs, [
      getAddress(trader),
      Number(side),
      BigInt(maxCost),
      Number(limitPriceBps),
      BigInt(nonce)
    ]);
    const commitmentHash = overrideCommitment ?? keccak256(encoded);
    const encrypted = await biteEncrypt(bite, encoded);

    const hash = await rpc(
      () =>
        wallet.writeContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "submitEncryptedOrder",
          args: [BigInt(marketId), encrypted, commitmentHash],
          account: from
        }),
      `submit-rejections-${label}`
    );
    return { label, hash };
  };

  const submissions = await Promise.all([
    // Valid orders to establish clearing price and matching.
    submit({
      label: "O1_valid_yes_A",
      wallet: walletA,
      from: traderA,
      trader: traderA.address,
      side: 1,
      maxCost: parseUnits("0.6", 6),
      limitPriceBps: 10_000,
      nonce: 101
    }),
    submit({
      label: "O2_valid_no_B",
      wallet: walletB,
      from: traderB,
      trader: traderB.address,
      side: 2,
      maxCost: parseUnits("0.4", 6),
      limitPriceBps: 10_000,
      nonce: 102
    }),
    // Commitment mismatch -> reject.
    submit({
      label: "O3_commitment_mismatch_C",
      wallet: walletC,
      from: traderC,
      trader: traderC.address,
      side: 2,
      maxCost: parseUnits("0.5", 6),
      limitPriceBps: 10_000,
      nonce: 103,
      overrideCommitment: keccak256(stringToBytes("wrong-commitment"))
    }),
    // Trader mismatch -> reject (payload trader != envelope trader).
    submit({
      label: "O4_trader_mismatch_D",
      wallet: walletD,
      from: traderD,
      trader: traderE.address,
      side: 2,
      maxCost: parseUnits("0.5", 6),
      limitPriceBps: 10_000,
      nonce: 104
    }),
    // Limit not met -> refunded at clearing.
    submit({
      label: "O5_limit_not_met_E",
      wallet: walletE,
      from: traderE,
      trader: traderE.address,
      side: 1,
      maxCost: parseUnits("0.1", 6),
      limitPriceBps: 5_000,
      nonce: 105
    })
  ]);

  // Collect orderIds from receipts (parallel wait).
  await mapLimit(
    submissions,
    EDGE_CONCURRENCY,
    async (s) => {
      const receipt = await rpc(() => publicClient.waitForTransactionReceipt({ hash: s.hash }), `wait-rejections-${s.label}`);
      const logs = parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: "OrderSubmitted" });
      const orderId = Number(logs?.[0]?.args?.orderId ?? 0);
      if (!orderId) throw new Error(`missing OrderSubmitted for ${s.label}`);
      scenario.orderIds[s.label] = orderId;
    }
  );

  const orderIds = Object.values(scenario.orderIds).map((v) => BigInt(v));

  const market = await rpc(() => readMarket(marketId), "readMarket-rejections");
  const chainTs2 = await chainNow();
  if (chainTs2 < Number(market.closeTime)) {
    await sleep((Number(market.closeTime) - chainTs2 + EDGE_WAIT_AFTER_CLOSE_SECONDS) * 1000);
  }

  const nextBatchId = await rpc(() => readNextBatchId(), "nextBatchId-rejections");
  const orderViews = await readOrders(orderIds);
  const ordersRoot = computeOrdersRoot(orderIds, orderViews);
  const expiry = BigInt((await chainNow()) + 1800);
  const signature = await attestor.signMessage({ message: { raw: batchDigest(marketId, nextBatchId, ordersRoot, expiry) } });

  const triggerHash = await rpc(
    () =>
      walletA.writeContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "triggerBatchDecrypt",
        args: [BigInt(marketId), orderIds, { batchId: nextBatchId, expiry, ordersRoot }, signature],
        value: CTX_GAS_PAYMENT
      }),
    "triggerBatchDecrypt-rejections"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash: triggerHash }), "waitTrigger-rejections");

  const processed = await waitForMarketState(marketId, 3 /* BATCH_PROCESSED */, EDGE_CTX_TIMEOUT_MS);
  scenario.checks.push({ name: "batch_processed", ok: processed.reached, lastState: processed.lastState });
  if (!processed.reached) return scenario;

  const afterBatch = await rpc(() => readMarket(marketId), "readMarketAfterBatch-rejections");
  scenario.checks.push({
    name: "clearing_price_expected_6000",
    ok: Number(afterBatch.clearingYesPriceBps) === 6000
  });

  const expected = {
    O3_commitment_mismatch_C: ReasonCode.COMMITMENT_MISMATCH,
    O4_trader_mismatch_D: ReasonCode.TRADER_MISMATCH,
    O5_limit_not_met_E: ReasonCode.LIMIT_NOT_MET
  };

  for (const [label, orderId] of Object.entries(scenario.orderIds)) {
    const order = await rpc(
      () =>
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "getOrder",
          args: [BigInt(orderId)]
        }),
      `getOrder-rejections-${label}`
    );
    const receipt = await rpc(
      () =>
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "getReceipt",
          args: [order.lastReceiptId]
        }),
      `getReceipt-rejections-${label}`
    );

    if (label in expected) {
      scenario.checks.push({
        name: `reason_${label}`,
        ok: Number(receipt.reasonCode) === expected[label]
      });
    }

    if (label === "O1_valid_yes_A") {
      scenario.checks.push({ name: "order1_filled", ok: Number(order.filledLots) === 100 });
    }
    if (label === "O2_valid_no_B") {
      scenario.checks.push({ name: "order2_filled", ok: Number(order.filledLots) === 100 });
    }
  }

  scenario.ok = scenario.checks.every((c) => c.ok);
  return scenario;
}

async function scenarioUnmatchedAllYes(accounts) {
  const name = "unmatched-all-yes-refunds";
  const scenario = { name, ok: false, marketId: null, orderIds: [], checks: [] };

  const now = await chainNow();
  const question = `edge-unmatched-${now}`;
  const questionHash = keccak256(stringToBytes(question));
  const metadataHash = keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [question, BigInt(now)])
  );

  const orderDepositUnit = parseUnits(String(EDGE_ORDER_DEPOSIT_USDC), 6);
  const maxStakePerOrder = orderDepositUnit;
  const maxTotalStake = parseUnits(String(EDGE_MAX_TOTAL_STAKE_USDC), 6);

  const closeTime = now + EDGE_CLOSE_DELAY_S2_SECONDS;
  const resolveBy = closeTime + EDGE_RESOLVE_BUFFER_SECONDS;

  const createHash = await rpc(
    () =>
      walletA.writeContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "createMarket",
        args: [
          {
            collateralToken: USDC_ADDRESS,
            questionHash,
            metadataHash,
            openTime: now - 30,
            closeTime,
            resolveBy,
            orderDepositUnit,
            maxStakePerOrder,
            maxTotalStake,
            attestor: attestor.address,
            approver: traderA.address,
            disputeWindowSeconds: EDGE_DISPUTE_WINDOW_SECONDS,
            allowlistEnabled: false,
            allowlist: []
          }
        ]
      }),
    "createMarket2"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash: createHash }), "waitCreateMarket2");

  const nextMarketId = await rpc(
    () =>
      publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "nextMarketId"
      }),
    "nextMarketId2"
  );
  const marketId = Number(nextMarketId - 1n);
  scenario.marketId = marketId;

  const bite = new BITE(RPC_URL);

  const submit = async (a, i) => {
    const encoded = encodeAbiParameters(orderArgs, [
      a.account.address,
      1,
      parseUnits("1", 6),
      10_000,
      BigInt(now + i + 1)
    ]);
    const commitmentHash = keccak256(encoded);
    const encrypted = await biteEncrypt(bite, encoded);

    const hash = await rpc(
      () =>
        a.wallet.writeContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "submitEncryptedOrder",
          args: [BigInt(marketId), encrypted, commitmentHash]
        }),
      `submit2-${a.name}`
    );
    return { name: a.name, hash };
  };

  const submissions = await Promise.all(accounts.map((a, i) => submit(a, i)));
  await mapLimit(
    submissions,
    EDGE_CONCURRENCY,
    async (s) => {
      const receipt = await rpc(() => publicClient.waitForTransactionReceipt({ hash: s.hash }), `wait2-${s.name}`);
      const logs = parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: "OrderSubmitted" });
      const orderId = Number(logs?.[0]?.args?.orderId ?? 0);
      if (!orderId) throw new Error(`missing OrderSubmitted for ${s.name}`);
      scenario.orderIds.push(orderId);
    }
  );

  const market = await rpc(() => readMarket(marketId), "readMarket2");
  const chainTs2 = await chainNow();
  if (chainTs2 < Number(market.closeTime)) {
    await sleep((Number(market.closeTime) - chainTs2 + EDGE_WAIT_AFTER_CLOSE_SECONDS) * 1000);
  }

  const nextBatchId = await rpc(() => readNextBatchId(), "nextBatchId-unmatched");
  const orderIds = scenario.orderIds.map((id) => BigInt(id));
  const orderViews = await readOrders(orderIds);
  const ordersRoot = computeOrdersRoot(orderIds, orderViews);
  const expiry = BigInt((await chainNow()) + 1800);
  const signature = await attestor.signMessage({ message: { raw: batchDigest(marketId, nextBatchId, ordersRoot, expiry) } });

  const triggerHash = await rpc(
    () =>
      walletA.writeContract({
        address: CONTRACT_ADDRESS,
        abi: marketAbi,
        functionName: "triggerBatchDecrypt",
        args: [BigInt(marketId), orderIds, { batchId: nextBatchId, expiry, ordersRoot }, signature],
        value: CTX_GAS_PAYMENT
      }),
    "triggerBatchDecrypt2"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash: triggerHash }), "waitTrigger2");

  const processed = await waitForMarketState(marketId, 3 /* BATCH_PROCESSED */, EDGE_CTX_TIMEOUT_MS);
  scenario.checks.push({ name: "batch_processed", ok: processed.reached, lastState: processed.lastState });
  if (!processed.reached) return scenario;

  const after = await rpc(() => readMarket(marketId), "readMarketAfter2");
  scenario.checks.push({ name: "matchedLots_is_zero", ok: BigInt(after.matchedLots) === 0n });

  for (const orderId of scenario.orderIds) {
    const order = await rpc(
      () =>
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "getOrder",
          args: [BigInt(orderId)]
        }),
      `getOrder2-${orderId}`
    );
    const receipt = await rpc(
      () =>
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "getReceipt",
          args: [order.lastReceiptId]
        }),
      `getReceipt2-${orderId}`
    );
    scenario.checks.push({ name: `order_${orderId}_unmatched`, ok: Number(receipt.reasonCode) === ReasonCode.UNMATCHED });
  }

  scenario.ok = scenario.checks.every((c) => c.ok);
  return scenario;
}

function mustPk(value, name) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

async function rpc(fn, label) {
  let last;
  for (let i = 0; i < 20; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const msg = sanitize(error);
      if (i === 19) break;
      await sleep(Math.min(10_000, 750 + i * 750));
      if (process.env.DEBUG_RPC === "1") {
        console.log(`[edge-tests:retry] ${label} attempt=${i + 1} err=${msg}`);
      }
    }
  }
  throw new Error(`${label} failed: ${sanitize(last)}`);
}

function sanitize(error) {
  if (!error) return "unknown error";
  return String(error.shortMessage || error.details || error.message || error)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

async function biteEncrypt(bite, encoded) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      return await bite.encryptMessage(encoded);
    } catch (error) {
      last = error;
      await sleep(800 + i * 900);
    }
  }
  throw new Error(`BITE encrypt failed: ${sanitize(last)}`);
}

async function readMarket(marketId) {
  return publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "getMarket",
    args: [BigInt(marketId)]
  });
}

async function readNextBatchId() {
  return publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: marketAbi,
    functionName: "nextBatchId"
  });
}

async function readOrders(orderIds) {
  const out = [];
  for (const id of orderIds) {
    // sequential to keep RPC stable
    // eslint-disable-next-line no-await-in-loop
    const order = await rpc(
      () =>
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: marketAbi,
          functionName: "getOrder",
          args: [id]
        }),
      "getOrderForRoot"
    );
    out.push(order);
  }
  return out;
}

function computeOrdersRoot(orderIds, orders) {
  let rolling = keccak256("0x");
  for (let i = 0; i < orderIds.length; i++) {
    rolling = keccak256(
      encodePacked(
        ["bytes32", "uint256", "bytes32", "address"],
        [rolling, orderIds[i], orders[i].commitmentHash, orders[i].trader]
      )
    );
  }
  return rolling;
}

function batchDigest(marketId, batchId, ordersRoot, expiry) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint64" }
      ],
      [CONTRACT_ADDRESS, BigInt(CHAIN_ID), BigInt(marketId), BigInt(batchId), ordersRoot, expiry]
    )
  );
}

function outcomeRevealDigest(marketId, commitmentHash, expiry) {
  return keccak256(
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
}

function flipOneBit(bytes32Hex) {
  const hex = String(bytes32Hex);
  const last = hex.slice(-2);
  const n = Number.parseInt(last, 16) ^ 0x01;
  return `${hex.slice(0, -2)}${n.toString(16).padStart(2, "0")}`;
}

async function waitForMarketState(marketId, wanted, timeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const m = await rpc(() => readMarket(marketId), "pollMarket");
    last = Number(m.state);
    if (last === wanted) return { reached: true, lastState: last };
    await sleep(EDGE_POLL_INTERVAL_MS);
  }
  return { reached: false, lastState: last };
}

async function chainNow() {
  const block = await rpc(() => publicClient.getBlock(), "getBlock");
  return Number(block.timestamp);
}

async function expectRevert(fn) {
  try {
    await fn();
    return { ok: false, reason: "did_not_revert" };
  } catch (error) {
    return { ok: true, reason: sanitize(error) };
  }
}

async function expectRevertSimulate(fn) {
  // simulateContract throws on reverts; the error object format can be noisy, so we only track ok/not-ok.
  try {
    await fn();
    return { ok: false, reason: "did_not_revert" };
  } catch (error) {
    return { ok: true, reason: sanitize(error) };
  }
}

async function readUsdcBalances(accounts) {
  const result = {};
  for (const a of accounts) {
    // eslint-disable-next-line no-await-in-loop
    const bal = await rpc(
      () =>
        publicClient.readContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [a.account.address]
        }),
      `balanceOf-${a.name}`
    );
    result[a.name] = bal;
  }
  return result;
}

function closeTo(actual, expected) {
  return Math.abs(actual - expected) < 0.01;
}

function envInt(name, def, { min, max } = {}) {
  const raw = process.env[name];
  const n = Number(raw ?? def);
  const safe = Number.isFinite(n) ? n : Number(def);
  if (typeof min === "number" && safe < min) return min;
  if (typeof max === "number" && safe > max) return max;
  return safe;
}

async function mapLimit(items, limit, fn) {
  const executing = new Set();
  const results = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    p.finally(() => executing.delete(p));
    if (executing.size >= limit) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
