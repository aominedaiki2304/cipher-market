import {
  createPublicClient,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseUnits,
  stringToBytes,
  type Address,
  type Hex
} from "viem";
import { getChainId, getWalletClient as getWagmiWalletClient, switchChain } from "@wagmi/core/actions";
import type { OnchainMarketView, OnchainReceiptView } from "@/lib/market-types";
import {
  API_BASE_URL,
  DEFAULT_USDC,
  EXPECTED_CHAIN_ID,
  PRIVATE_PREDICTION_MARKET_ADDRESS,
  RPC_URL,
  ZERO_ADDRESS,
  skaleBiteChain
} from "@/lib/env";
import { wagmiConfig } from "@/lib/wagmi";

export {
  API_BASE_URL,
  DEFAULT_USDC,
  EXPECTED_CHAIN_ID,
  PRIVATE_PREDICTION_MARKET_ADDRESS,
  RPC_URL,
  skaleBiteChain
};

const FALLBACK_MARKET = ZERO_ADDRESS;

// Must match `MarketState` enum order in `contracts/src/PrivatePredictionMarket.sol`.
const marketStateLabels = [
  "CREATED",
  "OPEN",
  "ORDER_CTX_REQUESTED",
  "BATCH_PROCESSED",
  "OUTCOME_COMMITTED",
  "OUTCOME_CTX_REQUESTED",
  "RESOLUTION_PROPOSED",
  "IN_DISPUTE",
  "RESOLVED",
  "CANCELLED"
] as const;

const receiptStatusLabels = ["SUCCESS", "FAILURE", "PENDING"] as const;
const reasonCodeLabels = [
  "NONE",
  "INVALID_ATTESTATION",
  "EXPIRED_ATTESTATION",
  "MARKET_NOT_OPEN",
  "MARKET_NOT_CLOSED",
  "INVALID_SIDE",
  "MAX_COST_OVER_LIMIT",
  "MARKET_CAP_EXCEEDED",
  "TRADER_NOT_ALLOWLISTED",
  "ORDER_ALREADY_PROCESSED",
  "CTX_SENDER_MISMATCH",
  "DISPUTE_REQUIRED",
  "TRANSFER_FAILED",
  "TRADER_MISMATCH",
  "UNKNOWN_ORDER",
  "COMMITMENT_MISMATCH",
  "INVALID_LIMIT_PRICE",
  "LIMIT_NOT_MET",
  "UNMATCHED",
  "PARTIAL_FILL",
  "OUTCOME_NOT_COMMITTED",
  "INVALID_OUTCOME",
  "OUTCOME_COMMITMENT_MISMATCH",
  "OUTCOME_CTX_SENDER_MISMATCH",
  "ALREADY_CLAIMED"
] as const;

const sideLabels = ["NONE", "YES", "NO"] as const;

export const marketAbi = [
  {
    type: "function",
    name: "nextMarketId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "getMarket",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "creator", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "questionHash", type: "bytes32" },
          { name: "metadataHash", type: "bytes32" },
          { name: "openTime", type: "uint64" },
          { name: "closeTime", type: "uint64" },
          { name: "resolveBy", type: "uint64" },
          { name: "orderDepositUnit", type: "uint256" },
          { name: "maxStakePerOrder", type: "uint256" },
          { name: "maxTotalStake", type: "uint256" },
          { name: "totalEscrowed", type: "uint256" },
          { name: "totalYesStake", type: "uint256" },
          { name: "totalNoStake", type: "uint256" },
          { name: "clearingYesPriceBps", type: "uint16" },
          { name: "matchedLots", type: "uint256" },
          { name: "attestor", type: "address" },
          { name: "approver", type: "address" },
          { name: "disputeWindowSeconds", type: "uint64" },
          { name: "allowlistEnabled", type: "bool" },
          { name: "state", type: "uint8" },
          { name: "proposedOutcome", type: "uint8" },
          { name: "finalOutcome", type: "uint8" },
          { name: "disputeDeadline", type: "uint64" },
          { name: "activeBatchId", type: "uint256" },
          { name: "outcomeCommitmentHash", type: "bytes32" },
          { name: "outcomeCtxSender", type: "address" },
          { name: "outcomeEvidenceHash", type: "bytes32" }
        ]
      }
    ]
  },
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "collateralToken", type: "address" },
          { name: "questionHash", type: "bytes32" },
          { name: "metadataHash", type: "bytes32" },
          { name: "openTime", type: "uint64" },
          { name: "closeTime", type: "uint64" },
          { name: "resolveBy", type: "uint64" },
          { name: "orderDepositUnit", type: "uint256" },
          { name: "maxStakePerOrder", type: "uint256" },
          { name: "maxTotalStake", type: "uint256" },
          { name: "attestor", type: "address" },
          { name: "approver", type: "address" },
          { name: "disputeWindowSeconds", type: "uint64" },
          { name: "allowlistEnabled", type: "bool" },
          { name: "allowlist", type: "address[]" }
        ]
      }
    ],
    outputs: [{ name: "marketId", type: "uint256" }]
  },
  {
    type: "function",
    name: "openMarket",
    stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "submitEncryptedOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "encryptedPayload", type: "bytes" },
      { name: "commitmentHash", type: "bytes32" }
    ],
    outputs: [{ name: "orderId", type: "uint256" }]
  },
  {
    type: "function",
    name: "nextReceiptId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "getReceipt",
    stateMutability: "view",
    inputs: [{ name: "receiptId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "receiptId", type: "uint256" },
          { name: "marketId", type: "uint256" },
          { name: "orderId", type: "uint256" },
          { name: "trader", type: "address" },
          { name: "status", type: "uint8" },
          { name: "reasonCode", type: "uint8" },
          { name: "conditionPassed", type: "bool" },
          { name: "executed", type: "bool" },
          { name: "side", type: "uint8" },
          { name: "amount", type: "uint256" },
          { name: "timestamp", type: "uint256" },
          { name: "evidenceHash", type: "bytes32" }
        ]
      }
    ]
  }
  ,
  {
    type: "function",
    name: "getPosition",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "trader", type: "address" }
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "yesLots", type: "uint256" },
          { name: "noLots", type: "uint256" },
          { name: "refundable", type: "uint256" },
          { name: "claimed", type: "bool" }
        ]
      }
    ]
  },
  {
    type: "function",
    name: "claimPayout",
    stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "getMarketOrderIds",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "marketId", type: "uint256" },
          { name: "trader", type: "address" },
          { name: "encryptedPayload", type: "bytes" },
          { name: "commitmentHash", type: "bytes32" },
          { name: "state", type: "uint8" },
          { name: "createdAt", type: "uint256" },
          { name: "ctxSender", type: "address" },
          { name: "batchId", type: "uint256" },
          { name: "side", type: "uint8" },
          { name: "maxCost", type: "uint256" },
          { name: "limitPriceBps", type: "uint16" },
          { name: "filledLots", type: "uint256" },
          { name: "stake", type: "uint256" },
          { name: "lastReceiptId", type: "uint256" },
          { name: "processed", type: "bool" }
        ]
      }
    ]
  }
] as const;

export const erc20Abi = [
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
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

let _publicClient:
  | ReturnType<typeof createPublicClient<typeof skaleBiteChain>>
  | null = null;

export function getPublicClient() {
  if (_publicClient) return _publicClient;
  _publicClient = createPublicClient({
    chain: skaleBiteChain,
    transport: http(RPC_URL, { retryCount: 3, retryDelay: 1_000, timeout: 30_000 })
  });
  return _publicClient;
}

export async function ensureWalletChain() {
  const current = getChainId(wagmiConfig);
  if (current === EXPECTED_CHAIN_ID) return;

  await switchChain(wagmiConfig, {
    chainId: EXPECTED_CHAIN_ID,
    addEthereumChainParameter: {
      chainName: "SKALE BITE v2 Sandbox",
      nativeCurrency: {
        name: "sFUEL",
        symbol: "sFUEL",
        decimals: 18
      },
      rpcUrls: [RPC_URL],
      blockExplorerUrls: ["https://base-sepolia-testnet-explorer.skalenodes.com:10032"]
    }
  });
}

export async function getWalletClient() {
  const client = await getWagmiWalletClient(wagmiConfig).catch(() => null);
  if (!client) {
    throw new Error("Connect wallet first.");
  }
  return client;
}

function shortHashTitle(questionHash: string, id: number) {
  return `Market #${id} (${questionHash.slice(0, 10)}...)`;
}

type RelayerMarketTitleRow = {
  marketId: number;
  title: string;
};

let cachedRelayerMarketTitles: Map<number, string> | null = null;
let cachedRelayerMarketTitlesAt = 0;
const RELAYER_MARKET_TITLE_CACHE_MS = 15_000;

async function getRelayerMarketTitleMap(): Promise<Map<number, string>> {
  const now = Date.now();
  if (cachedRelayerMarketTitles && now - cachedRelayerMarketTitlesAt < RELAYER_MARKET_TITLE_CACHE_MS) {
    return cachedRelayerMarketTitles;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/api/relayer/markets?limit=200`, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    if (!res.ok) {
      cachedRelayerMarketTitles = new Map();
      cachedRelayerMarketTitlesAt = now;
      return cachedRelayerMarketTitles;
    }

    const json = (await res.json()) as { markets?: RelayerMarketTitleRow[] };
    const titles = new Map<number, string>();
    for (const row of Array.isArray(json?.markets) ? json.markets : []) {
      const id = Number((row as any)?.marketId);
      const title = String((row as any)?.title || "").trim();
      if (!Number.isFinite(id) || id <= 0) continue;
      if (!title) continue;
      titles.set(id, title);
    }

    cachedRelayerMarketTitles = titles;
    cachedRelayerMarketTitlesAt = now;
    return titles;
  } catch (_err) {
    cachedRelayerMarketTitles = new Map();
    cachedRelayerMarketTitlesAt = now;
    return cachedRelayerMarketTitles;
  }
}

function toDateLabel(unixSeconds: number) {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString();
}

function toProbability(yesStake: bigint, noStake: bigint) {
  const total = yesStake + noStake;
  if (total === 0n) return 50;
  return Number((yesStake * 10000n) / total) / 100;
}

function toStateLabel(code: number) {
  return marketStateLabels[code] || "CREATED";
}

function toBigIntSafe(value: unknown, fallback: bigint = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch (_err) {
      return fallback;
    }
  }
  return fallback;
}

export async function fetchOnchainMarkets(): Promise<OnchainMarketView[]> {
  if (PRIVATE_PREDICTION_MARKET_ADDRESS === FALLBACK_MARKET) {
    return [];
  }

  const publicClient = getPublicClient();
  const relayerTitles = await getRelayerMarketTitleMap();
  const nextMarketId = (await publicClient.readContract({
    address: PRIVATE_PREDICTION_MARKET_ADDRESS,
    abi: marketAbi,
    functionName: "nextMarketId"
  })) as bigint;

  if (nextMarketId <= 1n) {
    return [];
  }

  // Scanning every market from 1..nextMarketId gets slow once the relayer has created many
  // short-lived demo markets. For UI purposes we only need the most recent N.
  const scanLimit = Number(import.meta.env.VITE_MARKET_SCAN_LIMIT || 40);
  const capped = Number.isFinite(scanLimit) ? Math.max(5, Math.min(250, Math.trunc(scanLimit))) : 40;
  const lastId = nextMarketId - 1n;
  const firstId = lastId > BigInt(capped) ? lastId - BigInt(capped) + 1n : 1n;

  const ids: bigint[] = [];
  for (let i = lastId; i >= firstId; i--) {
    ids.push(i);
    if (i === 1n) break;
  }

  const rawMarkets = await Promise.all(
    ids.map((id) =>
      publicClient
        .readContract({
          address: PRIVATE_PREDICTION_MARKET_ADDRESS,
          abi: marketAbi,
          functionName: "getMarket",
          args: [id]
        })
        .catch(() => null)
    )
  );

  const mapped = rawMarkets
    .filter((m): m is any => Boolean(m) && Number((m as any).id) > 0)
    .map((m) => {
      const id = Number(m.id);
      const stateCode = Number(m.state);
      const yesProbability = toProbability(m.totalYesStake, m.totalNoStake);
      const noProbability = Math.max(0, Math.min(100, 100 - yesProbability));
      const category = toStateLabel(stateCode);
      return {
        id,
        slug: String(id),
        title: relayerTitles.get(id) || shortHashTitle(m.questionHash, id),
        questionHash: m.questionHash,
        category,
        image: "🔐",
        outcomes: [
          {
            name: "Yes" as const,
            probability: Number(yesProbability.toFixed(2)),
            poolAmount: `${formatUnits(m.totalYesStake, 6)} USDC`
          },
          {
            name: "No" as const,
            probability: Number(noProbability.toFixed(2)),
            poolAmount: `${formatUnits(m.totalNoStake, 6)} USDC`
          }
        ],
        volume: `${formatUnits(m.totalEscrowed, 6)} USDC`,
        endDate: toDateLabel(Number(m.closeTime)),
        type: "binary" as const,
        state: toStateLabel(stateCode),
        stateCode,
        finalOutcomeCode: Number(m.finalOutcome),
        creator: getAddress(m.creator),
        collateralToken: getAddress(m.collateralToken),
        attestor: getAddress(m.attestor),
        approver: getAddress(m.approver),
        openTime: Number(m.openTime),
        closeTime: Number(m.closeTime),
        resolveBy: Number(m.resolveBy),
        orderDepositUnit: m.orderDepositUnit,
        maxStakePerOrder: m.maxStakePerOrder,
        maxTotalStake: m.maxTotalStake,
        totalEscrowed: m.totalEscrowed,
        totalYesStake: m.totalYesStake,
        totalNoStake: m.totalNoStake,
        // viem may return small ints as `number`; ensure we always store bigint for downstream math.
        clearingYesPriceBps: toBigIntSafe((m as any).clearingYesPriceBps, 0n),
        matchedLots: (m.matchedLots as bigint) ?? 0n,
        outcomeCommitmentHash: m.outcomeCommitmentHash,
        outcomeCtxSender: getAddress(m.outcomeCtxSender),
        outcomeEvidenceHash: m.outcomeEvidenceHash,
        allowlistEnabled: Boolean(m.allowlistEnabled)
      };
    })
    .sort((a, b) => b.id - a.id);

  return mapped;
}

export async function fetchOnchainReceipts(params: {
  marketId?: number;
  limit?: number;
}): Promise<OnchainReceiptView[]> {
  const { marketId, limit = 25 } = params;
  if (PRIVATE_PREDICTION_MARKET_ADDRESS === FALLBACK_MARKET) {
    return [];
  }

  const publicClient = getPublicClient();
  const nextReceiptId = (await publicClient.readContract({
    address: PRIVATE_PREDICTION_MARKET_ADDRESS,
    abi: marketAbi,
    functionName: "nextReceiptId"
  })) as bigint;

  const receipts: OnchainReceiptView[] = [];
  const start = nextReceiptId > BigInt(limit) ? nextReceiptId - BigInt(limit) : 1n;

  for (let id = nextReceiptId - 1n; id >= start && id > 0n; id--) {
    const r: any = await publicClient
      .readContract({
        address: PRIVATE_PREDICTION_MARKET_ADDRESS,
        abi: marketAbi,
        functionName: "getReceipt",
        args: [id]
      })
      .catch(() => null);
    if (!r || Number(r.receiptId) === 0) {
      continue;
    }
    if (marketId && Number(r.marketId) !== marketId) {
      continue;
    }

    receipts.push({
      receiptId: Number(r.receiptId),
      marketId: Number(r.marketId),
      orderId: Number(r.orderId),
      trader: getAddress(r.trader),
      status: receiptStatusLabels[Number(r.status)] || "UNKNOWN",
      reasonCode: reasonCodeLabels[Number(r.reasonCode)] || `REASON_${Number(r.reasonCode)}`,
      side: sideLabels[Number(r.side)] || "NONE",
      amount: formatUnits(r.amount, 6),
      timestamp: Number(r.timestamp),
      evidenceHash: r.evidenceHash
    });
  }

  return receipts;
}

export async function readAllowance(params: {
  owner: Address;
  token: Address;
  spender: Address;
}) {
  const publicClient = getPublicClient();
  return (await publicClient.readContract({
    address: params.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [params.owner, params.spender]
  })) as bigint;
}

export async function readTokenBalance(params: { owner: Address; token: Address }) {
  const publicClient = getPublicClient();
  return (await publicClient.readContract({
    address: params.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [params.owner]
  })) as bigint;
}

export async function approveDeposit(params: {
  account: Address;
  token: Address;
  spender: Address;
  amount: bigint;
}) {
  await ensureWalletChain();
  const walletClient = await getWalletClient();
  const hash = await walletClient.writeContract({
    address: params.token,
    abi: erc20Abi,
    functionName: "approve",
    args: [params.spender, params.amount],
    account: params.account
  });

  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

export async function submitEncryptedOrder(params: {
  marketId: number;
  account: Address;
  side: 1 | 2;
  stake: bigint;
  limitPriceBps?: number;
  nonce?: number;
  apiBaseUrl?: string;
}) {
  await ensureWalletChain();
  const apiBaseUrl = params.apiBaseUrl || API_BASE_URL;
  const nonce = params.nonce ?? Date.now();

  const encryptRes = await fetch(`${apiBaseUrl}/api/encrypt-order`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trader: params.account,
      side: params.side,
      stake: params.stake.toString(),
      limitPriceBps: params.limitPriceBps ?? 10000,
      nonce
    })
  });

  const encryptPayload = await encryptRes.json();
  if (!encryptRes.ok) {
    throw new Error(encryptPayload?.error || "Encryption request failed");
  }

  const encryptedPayload = encryptPayload.encryptedPayload as Hex;
  const commitmentHash = encryptPayload.commitmentHash as Hex;

  const walletClient = await getWalletClient();
  const hash = await walletClient.writeContract({
    address: PRIVATE_PREDICTION_MARKET_ADDRESS,
    abi: marketAbi,
    functionName: "submitEncryptedOrder",
    args: [BigInt(params.marketId), encryptedPayload, commitmentHash],
    account: params.account
  });

  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

export async function createAndOpenMarket(params: {
  account: Address;
  question: string;
  attestor: Address;
  approver: Address;
  collateralToken?: Address;
  orderDepositUnit?: bigint;
  maxStakePerOrder?: bigint;
  maxTotalStake?: bigint;
  openDelaySeconds?: number;
  closeDelaySeconds?: number;
  resolveDelaySeconds?: number;
}) {
  await ensureWalletChain();
  const walletClient = await getWalletClient();
  const publicClient = getPublicClient();

  const now = Math.floor(Date.now() / 1000);
  // For demo UX we want a one-click market that is immediately OPEN.
  // Setting openTime in the past avoids needing a separate `openMarket()` step.
  const openTime = now - 60;
  // Short demo close window so relayer can batch-decrypt quickly.
  const closeTime = now + (params.closeDelaySeconds ?? 60);
  const resolveBy = now + (params.resolveDelaySeconds ?? 7200);

  const orderDepositUnit = params.orderDepositUnit ?? parseUnits("1", 6);
  const maxStakePerOrder = params.maxStakePerOrder ?? parseUnits("1", 6);
  const maxTotalStake = params.maxTotalStake ?? parseUnits("10", 6);

  const questionHash = keccak256(stringToBytes(params.question));
  const metadataHash = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }],
      [params.question, BigInt(now)]
    )
  );

  const createHash = await walletClient.writeContract({
    address: PRIVATE_PREDICTION_MARKET_ADDRESS,
    abi: marketAbi,
    functionName: "createMarket",
    args: [
      {
        collateralToken: params.collateralToken || DEFAULT_USDC,
        questionHash,
        metadataHash,
        openTime,
        closeTime,
        resolveBy,
        orderDepositUnit,
        maxStakePerOrder,
        maxTotalStake,
        attestor: params.attestor,
        approver: params.approver,
        // Keep short so finalizeResolution is reachable quickly for demo runs.
        disputeWindowSeconds: 60,
        allowlistEnabled: false,
        allowlist: []
      }
    ],
    account: params.account
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash });

  const nextMarketId = (await publicClient.readContract({
    address: PRIVATE_PREDICTION_MARKET_ADDRESS,
    abi: marketAbi,
    functionName: "nextMarketId"
  })) as bigint;
  const marketId = Number(nextMarketId - 1n);

  return {
    marketId,
    createTxHash: createHash
  };
}

export function toStakeUnits(amountInput: string) {
  const normalized = amountInput.trim();
  if (!normalized) return 0n;
  return parseUnits(normalized, 6);
}

export async function readPosition(params: { marketId: number; trader: Address }) {
  const publicClient = getPublicClient();
  const position = (await publicClient.readContract({
    address: PRIVATE_PREDICTION_MARKET_ADDRESS,
    abi: marketAbi,
    functionName: "getPosition",
    args: [BigInt(params.marketId), params.trader]
  })) as any;

  return {
    yesLots: position.yesLots as bigint,
    noLots: position.noLots as bigint,
    refundable: position.refundable as bigint,
    claimed: Boolean(position.claimed)
  };
}

export async function claimPayout(params: { marketId: number; account: Address }) {
  await ensureWalletChain();
  const walletClient = await getWalletClient();
  const hash = await walletClient.writeContract({
    address: PRIVATE_PREDICTION_MARKET_ADDRESS,
    abi: marketAbi,
    functionName: "claimPayout",
    args: [BigInt(params.marketId)],
    account: params.account
  });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

export async function readTraderOrdersInMarket(params: { marketId: number; trader: Address }) {
  const publicClient = getPublicClient();
  const trader = getAddress(params.trader).toLowerCase();

  const orderIds = (await publicClient
    .readContract({
      address: PRIVATE_PREDICTION_MARKET_ADDRESS,
      abi: marketAbi,
      functionName: "getMarketOrderIds",
      args: [BigInt(params.marketId)]
    })
    .catch(() => [])) as bigint[];

  if (!orderIds?.length) return [];

  const rawOrders = await Promise.all(
    orderIds.map((id) =>
      publicClient
        .readContract({
          address: PRIVATE_PREDICTION_MARKET_ADDRESS,
          abi: marketAbi,
          functionName: "getOrder",
          args: [id]
        })
        .catch(() => null)
    )
  );

  const orders: Array<{
    orderId: number;
    marketId: number;
    createdAt: number;
    processed: boolean;
    sideCode: number;
    stake: bigint;
  }> = [];

  for (const o of rawOrders as any[]) {
    if (!o) continue;
    const who = String(o.trader || "").toLowerCase();
    if (!who) continue;
    if (getAddress(who as Address).toLowerCase() !== trader) continue;
    orders.push({
      orderId: Number(o.id),
      marketId: Number(o.marketId),
      createdAt: Number(o.createdAt),
      processed: Boolean(o.processed),
      sideCode: Number(o.side),
      stake: (o.stake as bigint) ?? 0n
    });
  }

  orders.sort((a, b) => b.orderId - a.orderId);
  return orders;
}
