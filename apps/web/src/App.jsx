import { useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodePacked,
  http,
  isAddress,
  keccak256,
  parseAbiItem,
  parseEther,
  parseEventLogs,
  stringToHex
} from "viem";
import { api } from "./lib/api.js";
import { cn } from "./lib/cn.js";
import { formatTimestamp, formatUsdcMicro } from "./lib/format.js";
import { privatePredictionMarketAbi } from "./abi/privatePredictionMarketAbi.js";

const RPC_URL = import.meta.env.VITE_RPC_URL || "https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox";
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 103698795);
const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EMPTY_HASH = `0x${"0".repeat(64)}`;

const CHAIN = {
  id: CHAIN_ID,
  name: "BITE v2 Sandbox",
  network: "bite-v2-sandbox",
  nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] }
  }
};

const STATUS_NAMES = ["SUCCESS", "FAILURE", "PENDING"];
const SIDE_NAMES = ["NONE", "YES", "NO"];
const REASON_NAMES = [
  "NONE",
  "INVALID_ATTESTATION",
  "EXPIRED_ATTESTATION",
  "MARKET_NOT_OPEN",
  "MARKET_NOT_CLOSED",
  "INVALID_SIDE",
  "STAKE_OVER_LIMIT",
  "MARKET_CAP_EXCEEDED",
  "TRADER_NOT_ALLOWLISTED",
  "ORDER_ALREADY_PROCESSED",
  "CTX_SENDER_MISMATCH",
  "RESOLUTION_TOO_EARLY",
  "DISPUTE_REQUIRED",
  "ALREADY_CLAIMED",
  "NO_WINNING_POOL",
  "TRANSFER_FAILED",
  "TRADER_MISMATCH",
  "UNKNOWN_ORDER"
];

const MARKET_STATE_NAMES = [
  "CREATED",
  "OPEN",
  "CTX_REQUESTED",
  "BATCH_PROCESSED",
  "RESOLUTION_PROPOSED",
  "IN_DISPUTE",
  "RESOLVED",
  "CANCELLED"
];

const OUTCOME_OPTIONS = [
  { value: 1, label: "YES" },
  { value: 2, label: "NO" },
  { value: 3, label: "INVALID" }
];

const STAGES = [
  { id: "markets", title: "Markets", subtitle: "Discover and monitor private binary markets" },
  { id: "create", title: "Create Market", subtitle: "Define policy, windows, and guardrails" },
  { id: "order", title: "Encrypted Order", subtitle: "Encrypt side/stake and submit sealed order" },
  { id: "batch", title: "Batch Trigger", subtitle: "Attest, submit CTX, and process decrypt callback" },
  { id: "resolve", title: "Resolve", subtitle: "Attested outcome, dispute, and finalization" },
  { id: "receipts", title: "Receipts", subtitle: "Structured evidence for every lifecycle action" }
];

const MARKET_CREATED_EVENT = parseAbiItem(
  "event MarketCreated(uint256 indexed marketId, address indexed creator, bytes32 questionHash, address collateralToken, uint64 openTime, uint64 closeTime)"
);
const ORDER_SUBMITTED_EVENT = parseAbiItem(
  "event OrderSubmitted(uint256 indexed marketId, uint256 indexed orderId, address indexed trader, bytes32 commitmentHash)"
);
const RECEIPT_EVENT = parseAbiItem(
  "event ReceiptRecorded(uint256 indexed receiptId, uint256 indexed marketId, uint256 indexed orderId, address trader, uint8 status, uint8 reasonCode, bool conditionPassed, bool executed, uint8 side, uint256 amount, bytes32 evidenceHash)"
);

const CATEGORY_CHIPS = [
  "Trending",
  "Macro",
  "Crypto",
  "Politics",
  "AI",
  "Sports",
  "Earnings",
  "Climate"
];

const BOARD_FILTERS = [
  "All",
  "Politics",
  "Macro",
  "Sports",
  "Crypto",
  "Earnings",
  "Tech",
  "Culture",
  "World",
  "Economy"
];

const DEMO_MARKETS = [
  {
    id: 101,
    title: "Fed decision in March?",
    outcomes: [
      { label: "50+ bps decrease", probability: 1 },
      { label: "25 bps decrease", probability: 7 }
    ],
    volume: "$98m Vol."
  },
  {
    id: 102,
    title: "Government shutdown on Saturday?",
    outcomes: [
      { label: "Yes", probability: 27 },
      { label: "No", probability: 73 }
    ],
    volume: "$7m Vol."
  },
  {
    id: 103,
    title: "BTC 5 Minute Up or Down",
    outcomes: [
      { label: "Up", probability: 50 },
      { label: "Down", probability: 50 }
    ],
    volume: "$3.2m Vol."
  },
  {
    id: 104,
    title: "What price will Bitcoin hit in February?",
    outcomes: [
      { label: "80,000", probability: 8 },
      { label: "75,000", probability: 28 }
    ],
    volume: "$56m Vol."
  },
  {
    id: 105,
    title: "US strikes Iran by...?",
    outcomes: [
      { label: "February 20", probability: 6 },
      { label: "February 28", probability: 12 }
    ],
    volume: "$245m Vol."
  },
  {
    id: 106,
    title: "S&P 500 opens up or down today?",
    outcomes: [
      { label: "Up", probability: 49 },
      { label: "Down", probability: 51 }
    ],
    volume: "$129k Vol."
  },
  {
    id: 107,
    title: "Will Bernie mention healthcare on Feb 13?",
    outcomes: [
      { label: "Healthcare / Health...", probability: 72 },
      { label: "Paycheck to Paycheck", probability: 86 }
    ],
    volume: "$118k Vol."
  },
  {
    id: 108,
    title: "2026 Winter Olympics: Most Gold Medals",
    outcomes: [
      { label: "Norway", probability: 88 },
      { label: "United States", probability: 10 }
    ],
    volume: "$10m Vol."
  }
];

export default function App() {
  const publicClient = useMemo(
    () => createPublicClient({ chain: CHAIN, transport: http(RPC_URL, { retryCount: 2 }) }),
    []
  );

  const [activeStage, setActiveStage] = useState("markets");
  const [apiState, setApiState] = useState({ status: "unknown", text: "API unchecked" });
  const [walletClient, setWalletClient] = useState(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [chainOk, setChainOk] = useState(false);

  const [busy, setBusy] = useState({
    connect: false,
    health: false,
    create: false,
    open: false,
    order: false,
    batch: false,
    resolve: false,
    dispute: false,
    finalize: false,
    claim: false,
    receipts: false
  });

  const [errorByAction, setErrorByAction] = useState({});
  const [timeline, setTimeline] = useState([]);

  const [marketForm, setMarketForm] = useState({
    contractAddress:
      import.meta.env.VITE_PRIVATE_PREDICTION_MARKET_ADDRESS ||
      import.meta.env.VITE_PRIVATE_PROCUREMENT_ADDRESS ||
      ZERO_ADDRESS,
    collateralToken: import.meta.env.VITE_USDC_ADDRESS || "0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8",
    questionText: "Will BTC close above 90k by month end?",
    metadataHash: `0x${"a".repeat(64)}`,
    openDelayMinutes: 0,
    closeDelayMinutes: 30,
    resolveDelayMinutes: 180,
    orderDepositUnit: "10000000",
    maxStakePerOrder: "10000000",
    maxTotalStake: "500000000",
    attestor: "0x0000000000000000000000000000000000000000",
    approver: "0x0000000000000000000000000000000000000000",
    disputeWindowSeconds: 900,
    allowlistEnabled: false,
    allowlistRaw: "",
    marketId: 0
  });

  const [orderForm, setOrderForm] = useState({
    marketId: 0,
    trader: "",
    side: 1,
    stake: "5000000",
    nonce: 1
  });

  const [batchForm, setBatchForm] = useState({
    marketId: 0,
    orderIdsRaw: "",
    batchId: 1,
    expiryMinutes: 30,
    ctxFeeEth: "0"
  });

  const [resolutionForm, setResolutionForm] = useState({
    marketId: 0,
    outcome: 1,
    evidenceHash: `0x${"b".repeat(64)}`,
    expiryMinutes: 30,
    disputeReasonHash: `0x${"c".repeat(64)}`,
    overrideReasonHash: `0x${"d".repeat(64)}`
  });

  const [encryptedOrder, setEncryptedOrder] = useState(null);
  const [batchAttestation, setBatchAttestation] = useState(null);
  const [resolutionAttestation, setResolutionAttestation] = useState(null);
  const [orders, setOrders] = useState([]);
  const [marketSnapshots, setMarketSnapshots] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [activeBoardFilter, setActiveBoardFilter] = useState("All");
  const [selectedMarketId, setSelectedMarketId] = useState(0);
  const [tradeDirection, setTradeDirection] = useState("buy");
  const [tradeSide, setTradeSide] = useState(1);
  const [tradeAmount, setTradeAmount] = useState("0");

  const marketMap = useMemo(() => {
    const map = new Map();
    for (const market of marketSnapshots) {
      map.set(Number(market.id), market);
    }
    return map;
  }, [marketSnapshots]);

  const orderMap = useMemo(() => {
    const map = new Map();
    for (const order of orders) {
      map.set(Number(order.orderId), order);
    }
    return map;
  }, [orders]);

  const boardMarkets = useMemo(() => {
    if (marketSnapshots.length === 0) {
      return DEMO_MARKETS;
    }

    return marketSnapshots.map((market) => {
      const yesStake = Number(market.totalYesStake || 0);
      const noStake = Number(market.totalNoStake || 0);
      const total = yesStake + noStake;
      const yesPct = total > 0 ? Math.max(1, Math.round((yesStake / total) * 100)) : 50;
      const noPct = Math.max(1, 100 - yesPct);
      return {
        id: Number(market.id),
        title: `Market #${market.id}`,
        outcomes: [
          { label: "YES", probability: yesPct },
          { label: "NO", probability: noPct }
        ],
        volume: `${formatUsdcMicro(market.totalEscrowed || 0)} Vol.`,
        state: market.state
      };
    });
  }, [marketSnapshots]);

  const selectedBoardMarket = useMemo(() => {
    const selected =
      boardMarkets.find((market) => Number(market.id) === Number(selectedMarketId)) || boardMarkets[0];
    return selected || null;
  }, [boardMarkets, selectedMarketId]);

  const trustCopy = [
    {
      key: "private",
      question: "What is private?",
      answer: "Each order keeps trader side and stake encrypted until the market close condition unlocks CTX decryption."
    },
    {
      key: "unlock",
      question: "When does it unlock?",
      answer: "Only after close time and a valid batch attestation are submitted through triggerBatchDecrypt."
    },
    {
      key: "trigger",
      question: "Who can trigger?",
      answer: "Any caller can trigger with valid attestation payload, but execution is fully bounded by on-chain policy checks."
    },
    {
      key: "failure",
      question: "What happens on failure?",
      answer: "Invalid orders or conditions are rejected and logged with structured reason codes in receipts."
    }
  ];

  const isBoardStage = activeStage === "markets";

  async function connectWallet() {
    clearActionError("connect");
    setBusy((prev) => ({ ...prev, connect: true }));

    try {
      if (!window.ethereum) {
        throw new Error("No injected wallet found. Install a browser wallet first.");
      }

      await window.ethereum.request({ method: "eth_requestAccounts" });
      const chainHex = await window.ethereum.request({ method: "eth_chainId" });
      if (chainHex?.toLowerCase() !== CHAIN_ID_HEX.toLowerCase()) {
        await switchToTargetChain();
      }

      const wc = createWalletClient({ chain: CHAIN, transport: custom(window.ethereum) });
      const [address] = await wc.getAddresses();
      if (!address) throw new Error("Wallet did not return an address.");

      setWalletClient(wc);
      setWalletAddress(address);
      setOrderForm((prev) => ({ ...prev, trader: address }));
      setChainOk(true);
      pushTimeline(`Wallet connected: ${shortHash(address)} on chain ${CHAIN_ID}`);
    } catch (error) {
      setWalletClient(null);
      setWalletAddress("");
      setChainOk(false);
      setActionError("connect", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, connect: false }));
    }
  }

  async function switchToTargetChain() {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CHAIN_ID_HEX }]
      });
      return;
    } catch (error) {
      if (Number(error?.code || 0) !== 4902) {
        throw error;
      }
    }

    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_ID_HEX,
          chainName: "BITE v2 Sandbox",
          nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [
            "https://base-sepolia-testnet-explorer.skalenodes.com:10032"
          ]
        }
      ]
    });
  }

  async function runHealthCheck() {
    clearActionError("health");
    setBusy((prev) => ({ ...prev, health: true }));

    try {
      const health = await api.health();
      setApiState({
        status: health.ok ? "ok" : "error",
        text: health.ok
          ? `API ready • chain ${health.chainId}`
          : "API health returned non-ok"
      });
    } catch (error) {
      setApiState({ status: "error", text: toError(error) });
      setActionError("health", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, health: false }));
    }
  }

  async function createMarketOnChain() {
    clearActionError("create");
    setBusy((prev) => ({ ...prev, create: true }));

    try {
      const contractAddress = requireContractAddress();
      const wc = requireWallet();
      const allowlist = parseAllowlist(marketForm.allowlistRaw);

      const nowSec = Math.floor(Date.now() / 1000);
      const openTime = BigInt(nowSec + Number(marketForm.openDelayMinutes) * 60);
      const closeTime = BigInt(nowSec + Number(marketForm.closeDelayMinutes) * 60);
      const resolveBy = BigInt(nowSec + Number(marketForm.resolveDelayMinutes) * 60);
      const questionHash = keccak256(stringToHex(marketForm.questionText));

      const txHash = await wc.writeContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "createMarket",
        account: walletAddress,
        args: [
          {
            collateralToken: marketForm.collateralToken,
            questionHash,
            metadataHash: marketForm.metadataHash,
            openTime,
            closeTime,
            resolveBy,
            orderDepositUnit: BigInt(marketForm.orderDepositUnit),
            maxStakePerOrder: BigInt(marketForm.maxStakePerOrder),
            maxTotalStake: BigInt(marketForm.maxTotalStake),
            attestor: marketForm.attestor,
            approver: marketForm.approver,
            disputeWindowSeconds: BigInt(marketForm.disputeWindowSeconds),
            allowlistEnabled: marketForm.allowlistEnabled,
            allowlist
          }
        ]
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const logs = parseEventLogs({
        abi: privatePredictionMarketAbi,
        logs: receipt.logs,
        eventName: "MarketCreated",
        strict: false
      });

      const marketId = Number(logs[0]?.args?.marketId || 0);
      if (marketId <= 0) {
        throw new Error("MarketCreated event not found in transaction receipt");
      }

      setMarketForm((prev) => ({ ...prev, marketId }));
      setOrderForm((prev) => ({ ...prev, marketId }));
      setBatchForm((prev) => ({ ...prev, marketId }));
      setResolutionForm((prev) => ({ ...prev, marketId }));
      setSelectedMarketId(marketId);
      await refreshMarket(contractAddress, marketId);
      pushTimeline(`Market created: #${marketId} (${shortHash(txHash)})`);
      setActiveStage("order");
    } catch (error) {
      setActionError("create", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, create: false }));
    }
  }

  async function openMarketOnChain() {
    clearActionError("open");
    setBusy((prev) => ({ ...prev, open: true }));

    try {
      const contractAddress = requireContractAddress();
      const wc = requireWallet();
      if (!marketForm.marketId) {
        throw new Error("Set market ID first.");
      }

      const txHash = await wc.writeContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "openMarket",
        account: walletAddress,
        args: [BigInt(marketForm.marketId)]
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await refreshMarket(contractAddress, marketForm.marketId);
      pushTimeline(`Market opened: #${marketForm.marketId} (${shortHash(txHash)})`);
    } catch (error) {
      setActionError("open", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, open: false }));
    }
  }

  async function encryptAndSubmitOrder(event) {
    event.preventDefault();
    clearActionError("order");
    setBusy((prev) => ({ ...prev, order: true }));

    try {
      const contractAddress = requireContractAddress();
      const wc = requireWallet();
      if (!orderForm.marketId) {
        throw new Error("Set market ID first.");
      }
      if (!isAddress(orderForm.trader)) {
        throw new Error("Trader address is invalid.");
      }

      const encrypted = await api.encryptOrder({
        trader: orderForm.trader,
        side: Number(orderForm.side),
        stake: orderForm.stake,
        nonce: Number(orderForm.nonce)
      });
      setEncryptedOrder(encrypted);

      const txHash = await wc.writeContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "submitEncryptedOrder",
        account: walletAddress,
        args: [
          BigInt(orderForm.marketId),
          encrypted.encryptedPayload,
          encrypted.commitmentHash
        ]
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const logs = parseEventLogs({
        abi: privatePredictionMarketAbi,
        logs: receipt.logs,
        eventName: "OrderSubmitted",
        strict: false
      });

      const orderId = Number(logs[0]?.args?.orderId || 0);
      if (orderId <= 0) {
        throw new Error("OrderSubmitted event not found in transaction receipt");
      }

      setOrders((prev) =>
        [
          {
            orderId,
            marketId: Number(orderForm.marketId),
            trader: orderForm.trader,
            side: Number(orderForm.side),
            stake: String(orderForm.stake),
            commitmentHash: encrypted.commitmentHash,
            txHash
          },
          ...prev
        ].sort((a, b) => b.orderId - a.orderId)
      );

      pushTimeline(`Encrypted order submitted: #${orderId} (${shortHash(txHash)})`);
      setBatchForm((prev) => ({
        ...prev,
        orderIdsRaw: prev.orderIdsRaw
          ? `${prev.orderIdsRaw},${orderId}`
          : `${orderId}`
      }));
      setActiveStage("batch");
    } catch (error) {
      setActionError("order", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, order: false }));
    }
  }

  async function triggerBatch(event) {
    event.preventDefault();
    clearActionError("batch");
    setBusy((prev) => ({ ...prev, batch: true }));

    try {
      const contractAddress = requireContractAddress();
      const wc = requireWallet();
      const orderIds = parseOrderIds(batchForm.orderIdsRaw);
      if (orderIds.length === 0) {
        throw new Error("Provide at least one order ID.");
      }

      const ordersRoot = computeOrdersRoot(orderIds, orderMap);
      const expiry = Math.floor(Date.now() / 1000) + Number(batchForm.expiryMinutes) * 60;

      const signed = await api.attestBatchTrigger({
        contractAddress,
        marketId: Number(batchForm.marketId),
        batchId: Number(batchForm.batchId),
        ordersRoot,
        expiry
      });

      setBatchAttestation(signed);

      const txHash = await wc.writeContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "triggerBatchDecrypt",
        account: walletAddress,
        args: [
          BigInt(batchForm.marketId),
          orderIds.map((id) => BigInt(id)),
          {
            batchId: BigInt(batchForm.batchId),
            expiry: Number(expiry),
            ordersRoot
          },
          signed.signature
        ],
        value: parseEther(batchForm.ctxFeeEth || "0")
      });

      const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      pushTimeline(`Batch trigger submitted: ${shortHash(txHash)} (block ${txReceipt.blockNumber})`);
      await syncOnChainReceipts(contractAddress, Number(batchForm.marketId));
      await refreshMarket(contractAddress, Number(batchForm.marketId));

      setBatchForm((prev) => ({ ...prev, batchId: Number(prev.batchId) + 1 }));
      setActiveStage("resolve");
    } catch (error) {
      setActionError("batch", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, batch: false }));
    }
  }

  async function proposeResolution(event) {
    event.preventDefault();
    clearActionError("resolve");
    setBusy((prev) => ({ ...prev, resolve: true }));

    try {
      const contractAddress = requireContractAddress();
      const wc = requireWallet();
      const expiry = Math.floor(Date.now() / 1000) + Number(resolutionForm.expiryMinutes) * 60;

      const signed = await api.attestResolution({
        contractAddress,
        marketId: Number(resolutionForm.marketId),
        outcome: Number(resolutionForm.outcome),
        evidenceHash: resolutionForm.evidenceHash,
        expiry
      });
      setResolutionAttestation(signed);

      const txHash = await wc.writeContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "proposeResolution",
        account: walletAddress,
        args: [
          {
            marketId: BigInt(resolutionForm.marketId),
            outcome: Number(resolutionForm.outcome),
            evidenceHash: resolutionForm.evidenceHash,
            expiry: Number(expiry)
          },
          signed.signature
        ]
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await syncOnChainReceipts(contractAddress, Number(resolutionForm.marketId));
      await refreshMarket(contractAddress, Number(resolutionForm.marketId));
      pushTimeline(`Resolution proposed: ${shortHash(txHash)}`);
    } catch (error) {
      setActionError("resolve", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, resolve: false }));
    }
  }

  async function openDispute() {
    clearActionError("dispute");
    setBusy((prev) => ({ ...prev, dispute: true }));

    try {
      const contractAddress = requireContractAddress();
      const wc = requireWallet();

      const txHash = await wc.writeContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "openDispute",
        account: walletAddress,
        args: [
          BigInt(resolutionForm.marketId),
          resolutionForm.disputeReasonHash
        ]
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await syncOnChainReceipts(contractAddress, Number(resolutionForm.marketId));
      await refreshMarket(contractAddress, Number(resolutionForm.marketId));
      pushTimeline(`Dispute opened: ${shortHash(txHash)}`);
    } catch (error) {
      setActionError("dispute", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, dispute: false }));
    }
  }

  async function finalizeResolution() {
    clearActionError("finalize");
    setBusy((prev) => ({ ...prev, finalize: true }));

    try {
      const contractAddress = requireContractAddress();
      const wc = requireWallet();

      const txHash = await wc.writeContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "finalizeResolution",
        account: walletAddress,
        args: [BigInt(resolutionForm.marketId)]
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await syncOnChainReceipts(contractAddress, Number(resolutionForm.marketId));
      await refreshMarket(contractAddress, Number(resolutionForm.marketId));
      pushTimeline(`Resolution finalized: ${shortHash(txHash)}`);
    } catch (error) {
      setActionError("finalize", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, finalize: false }));
    }
  }

  async function overrideResolution() {
    clearActionError("finalize");
    setBusy((prev) => ({ ...prev, finalize: true }));

    try {
      const contractAddress = requireContractAddress();
      const wc = requireWallet();

      const txHash = await wc.writeContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "overrideResolution",
        account: walletAddress,
        args: [
          BigInt(resolutionForm.marketId),
          Number(resolutionForm.outcome),
          resolutionForm.overrideReasonHash
        ]
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await syncOnChainReceipts(contractAddress, Number(resolutionForm.marketId));
      await refreshMarket(contractAddress, Number(resolutionForm.marketId));
      pushTimeline(`Resolution overridden: ${shortHash(txHash)}`);
    } catch (error) {
      setActionError("finalize", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, finalize: false }));
    }
  }

  async function claimPayout() {
    clearActionError("claim");
    setBusy((prev) => ({ ...prev, claim: true }));

    try {
      const contractAddress = requireContractAddress();
      const wc = requireWallet();

      const txHash = await wc.writeContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "claimPayout",
        account: walletAddress,
        args: [BigInt(resolutionForm.marketId)]
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await syncOnChainReceipts(contractAddress, Number(resolutionForm.marketId));
      pushTimeline(`Claim executed: ${shortHash(txHash)}`);
      setActiveStage("receipts");
    } catch (error) {
      setActionError("claim", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, claim: false }));
    }
  }

  async function syncOnChainReceipts(contractAddress, focusMarketId = 0) {
    clearActionError("receipts");
    setBusy((prev) => ({ ...prev, receipts: true }));

    try {
      const currentBlock = await publicClient.getBlockNumber();
      const fromBlock = currentBlock > 4000n ? currentBlock - 4000n : 0n;

      const logs = await publicClient.getLogs({
        address: contractAddress,
        event: RECEIPT_EVENT,
        fromBlock,
        toBlock: "latest"
      });

      const normalized = await Promise.all(
        logs
          .filter((log) =>
            focusMarketId
              ? Number(log.args.marketId) === Number(focusMarketId)
              : true
          )
          .map((log) =>
            api.normalizeReceipt({
              receiptId: Number(log.args.receiptId),
              marketId: Number(log.args.marketId),
              orderId: Number(log.args.orderId),
              trader: log.args.trader,
              status: STATUS_NAMES[Number(log.args.status)] || "UNKNOWN",
              reasonCode: REASON_NAMES[Number(log.args.reasonCode)] || "UNKNOWN",
              conditionPassed: Boolean(log.args.conditionPassed),
              executed: Boolean(log.args.executed),
              side: SIDE_NAMES[Number(log.args.side)] || "NONE",
              amount: String(log.args.amount),
              evidenceHash: log.args.evidenceHash,
              token: marketForm.collateralToken,
              timestamp: new Date().toISOString()
            })
          )
      );

      if (normalized.length > 0) {
        setReceipts((prev) => dedupeReceipts([...normalized.reverse(), ...prev]));
        pushTimeline(`Synced ${normalized.length} receipt event(s) from chain`);
      } else {
        pushTimeline("No on-chain receipts found in the current scan window");
      }
    } catch (error) {
      setActionError("receipts", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, receipts: false }));
    }
  }

  async function loadDemoReceipts() {
    clearActionError("receipts");
    setBusy((prev) => ({ ...prev, receipts: true }));

    try {
      const payload = await api.fetchDemoReceipts();
      setReceipts(payload.receipts || []);
      setActiveStage("receipts");
      pushTimeline("Demo receipt set loaded from artifacts");
    } catch (error) {
      setActionError("receipts", toError(error));
    } finally {
      setBusy((prev) => ({ ...prev, receipts: false }));
    }
  }

  async function refreshMarket(contractAddress, marketId) {
    try {
      const market = await publicClient.readContract({
        address: contractAddress,
        abi: privatePredictionMarketAbi,
        functionName: "getMarket",
        args: [BigInt(marketId)]
      });

      const snapshot = {
        id: Number(market.id),
        questionHash: market.questionHash,
        state: MARKET_STATE_NAMES[Number(market.state)] || "UNKNOWN",
        totalEscrowed: String(market.totalEscrowed),
        totalYesStake: String(market.totalYesStake),
        totalNoStake: String(market.totalNoStake),
        closeTime: Number(market.closeTime),
        disputeDeadline: Number(market.disputeDeadline),
        finalOutcome: Number(market.finalOutcome),
        proposedOutcome: Number(market.proposedOutcome)
      };

      setMarketSnapshots((prev) => {
        const filtered = prev.filter((item) => Number(item.id) !== Number(snapshot.id));
        return [snapshot, ...filtered].sort((a, b) => Number(b.id) - Number(a.id));
      });
    } catch (error) {
      setActionError("markets", toError(error));
    }
  }

  function parseAllowlist(raw) {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => isAddress(line));
  }

  function parseOrderIds(raw) {
    return raw
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  function computeOrdersRoot(orderIds, orderById) {
    let rolling = keccak256("0x");

    for (const id of orderIds) {
      const order = orderById.get(Number(id));
      if (!order) {
        throw new Error(`Order #${id} is missing locally; submit/sync it before trigger.`);
      }

      rolling = keccak256(
        encodePacked(
          ["bytes32", "uint256", "bytes32", "address"],
          [rolling, BigInt(id), order.commitmentHash, order.trader]
        )
      );
    }

    return rolling;
  }

  function requireWallet() {
    if (!walletClient || !walletAddress) {
      throw new Error("Connect wallet first.");
    }
    return walletClient;
  }

  function requireContractAddress() {
    if (!isAddress(marketForm.contractAddress)) {
      throw new Error("Contract address is invalid.");
    }
    if (marketForm.contractAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new Error("Set a deployed market contract address first.");
    }
    return marketForm.contractAddress;
  }

  function setActionError(key, message) {
    setErrorByAction((prev) => ({ ...prev, [key]: message }));
  }

  function clearActionError(key) {
    setErrorByAction((prev) => ({ ...prev, [key]: "" }));
  }

  function pushTimeline(message) {
    setTimeline((prev) =>
      [{ id: crypto.randomUUID(), ts: new Date().toISOString(), message }, ...prev].slice(0, 40)
    );
  }

  return (
    <div className="min-h-dvh bg-[#090f18] text-slate-100 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      <a href="#main-content" className="skip-link">Skip to main content</a>

      <header className="border-b border-slate-800/90 bg-[#0b1322]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1600px] items-center gap-3 px-4 py-3 md:px-6">
          <div className="flex shrink-0 items-center gap-2">
            <div className="size-6 rounded-md border border-slate-500/70 bg-slate-900" />
            <p className="font-display text-[1.65rem] leading-none text-slate-100">CipherMarket</p>
            <span className="rounded-md border border-slate-700 bg-slate-900/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-sky-300">
              CTX
            </span>
          </div>

          <div className="ml-4 hidden flex-1 lg:block">
            <input
              className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-[#101b30] px-4 text-sm text-pretty text-slate-200 placeholder:text-slate-500"
              placeholder="Search polymarket-style private markets"
            />
          </div>

          <a href="#main-content" className="hidden text-sm font-medium text-sky-300 lg:block">
            How it works
          </a>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={connectWallet}
              className="focus-ring h-10 rounded-lg border border-slate-700 bg-[#101827] px-3 text-sm font-semibold"
              disabled={busy.connect}
            >
              {busy.connect ? "Connecting..." : walletAddress ? shortHash(walletAddress) : "Connect"}
            </button>
            <button
              type="button"
              onClick={runHealthCheck}
              className="focus-ring h-10 rounded-lg border border-slate-700 bg-[#101827] px-3 text-sm font-semibold"
              disabled={busy.health}
            >
              {busy.health ? "Checking..." : "API"}
            </button>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap gap-2 px-4 pb-3 md:px-6">
          {CATEGORY_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => setActiveStage("markets")}
              className={cn(
                "focus-ring rounded-md border px-3 py-1.5 text-xs font-semibold",
                chip === "Trending"
                  ? "border-sky-400/60 bg-sky-500/15 text-sky-100"
                  : "border-slate-700 bg-[#101827] text-slate-300 hover:border-slate-500"
              )}
            >
              {chip}
            </button>
          ))}
        </div>
      </header>

      <div
        className={cn(
          "mx-auto grid w-full max-w-[1600px] gap-4 px-4 py-4 md:px-6",
          isBoardStage
            ? "xl:grid-cols-[minmax(0,1fr)_360px]"
            : "xl:grid-cols-[300px_minmax(0,1fr)_360px]"
        )}
      >
        {!isBoardStage ? (
          <aside className="rounded-2xl border border-slate-800 bg-[#0f1724] p-4">
          <h2 className="font-display text-2xl">Trust Model</h2>
          <ul className="mt-3 space-y-3">
            {trustCopy.map((item) => (
              <li key={item.key} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="text-sm font-semibold text-slate-100">{item.question}</p>
                <p className="mt-1 text-pretty text-sm text-slate-400">{item.answer}</p>
              </li>
            ))}
          </ul>

          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-xs uppercase text-slate-400">System</p>
            <p
              className={cn(
                "mt-1 text-sm font-semibold",
                apiState.status === "ok" ? "text-emerald-300" : "text-amber-200"
              )}
            >
              {apiState.text}
            </p>
            <p className={cn("mt-1 text-sm", chainOk ? "text-emerald-300" : "text-rose-300")}>
              {chainOk ? `Chain OK (${CHAIN_ID})` : `Expected chain ${CHAIN_ID}`}
            </p>
          </div>
          </aside>
        ) : null}

        <main id="main-content" className="min-w-0 space-y-3" aria-label="workflow">
          <nav className="flex flex-wrap gap-2" aria-label="workflow stages">
            {STAGES.map((stage, index) => (
              <button
                key={stage.id}
                type="button"
                onClick={() => setActiveStage(stage.id)}
                className={cn(
                  "focus-ring rounded-md border px-3 py-1.5 text-left text-xs font-semibold",
                  activeStage === stage.id
                    ? "border-sky-400/60 bg-sky-500/15 text-sky-100"
                    : "border-slate-700 bg-[#101827] text-slate-300 hover:border-slate-500"
                )}
              >
                <span className="mr-2 font-mono text-[10px] tabular-nums text-slate-500">0{index + 1}</span>
                {stage.title}
              </button>
            ))}
          </nav>

          {activeStage === "markets" ? (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-[#0f1724] px-3 py-2">
                {BOARD_FILTERS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => setActiveBoardFilter(chip)}
                    className={cn(
                      "focus-ring rounded-md px-3 py-1.5 text-xs font-semibold",
                      activeBoardFilter === chip
                        ? "bg-sky-500/20 text-sky-100"
                        : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                    )}
                  >
                    {chip}
                  </button>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {boardMarkets.map((market) => (
                  <MarketBoardCard
                    key={market.id}
                    market={market}
                    selected={Number(selectedBoardMarket?.id) === Number(market.id)}
                    onSelect={() => {
                      const id = Number(market.id);
                      setSelectedMarketId(id);
                      setMarketForm((prev) => ({ ...prev, marketId: id }));
                      setOrderForm((prev) => ({ ...prev, marketId: id }));
                      setBatchForm((prev) => ({ ...prev, marketId: id }));
                      setResolutionForm((prev) => ({ ...prev, marketId: id }));
                    }}
                  />
                ))}
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {trustCopy.map((item) => (
                  <article key={item.key} className="rounded-xl border border-slate-800 bg-[#0f1724] p-3">
                    <p className="text-sm font-semibold text-slate-100">{item.question}</p>
                    <p className="mt-1 text-sm text-slate-400">{item.answer}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {activeStage === "create" ? (
            <section className="rounded-2xl border border-slate-800 bg-[#0f1724] p-4">
              <h2 className="font-display text-2xl">Create Market</h2>
              <p className="mt-1 text-pretty text-sm text-slate-400">
                Define close window, attestor, caps, and optional allowlist guardrails.
              </p>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <Field label="Contract address">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 font-mono text-sm"
                    value={marketForm.contractAddress}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, contractAddress: e.target.value }))}
                  />
                </Field>
                <Field label="Collateral token">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 font-mono text-sm"
                    value={marketForm.collateralToken}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, collateralToken: e.target.value }))}
                  />
                </Field>

                <Field className="md:col-span-2" label="Market question">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3"
                    value={marketForm.questionText}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, questionText: e.target.value }))}
                  />
                </Field>

                <Field label="Metadata hash">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 font-mono text-xs"
                    value={marketForm.metadataHash}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, metadataHash: e.target.value }))}
                  />
                </Field>
                <Field label="Attestor address">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 font-mono text-sm"
                    value={marketForm.attestor}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, attestor: e.target.value }))}
                  />
                </Field>

                <Field label="Approver address">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 font-mono text-sm"
                    value={marketForm.approver}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, approver: e.target.value }))}
                  />
                </Field>
                <Field label="Dispute window (seconds)">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={marketForm.disputeWindowSeconds}
                    onChange={(e) =>
                      setMarketForm((prev) => ({ ...prev, disputeWindowSeconds: Number(e.target.value) }))
                    }
                  />
                </Field>

                <Field label="Close in (minutes)">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={marketForm.closeDelayMinutes}
                    onChange={(e) =>
                      setMarketForm((prev) => ({ ...prev, closeDelayMinutes: Number(e.target.value) }))
                    }
                  />
                </Field>
                <Field label="Resolve in (minutes)">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={marketForm.resolveDelayMinutes}
                    onChange={(e) =>
                      setMarketForm((prev) => ({ ...prev, resolveDelayMinutes: Number(e.target.value) }))
                    }
                  />
                </Field>

                <Field label="Order deposit (USDC micro)">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={marketForm.orderDepositUnit}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, orderDepositUnit: e.target.value }))}
                  />
                </Field>
                <Field label="Max stake per order">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={marketForm.maxStakePerOrder}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, maxStakePerOrder: e.target.value }))}
                  />
                </Field>

                <Field label="Max total stake">
                  <input
                    className="focus-ring h-11 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={marketForm.maxTotalStake}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, maxTotalStake: e.target.value }))}
                  />
                </Field>

                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    className="focus-ring size-4 rounded border border-slate-700 bg-slate-950"
                    type="checkbox"
                    checked={marketForm.allowlistEnabled}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, allowlistEnabled: e.target.checked }))}
                  />
                  Enforce trader allowlist
                </label>

                <Field className="md:col-span-2" label="Allowlist (one address per line)">
                  <textarea
                    rows={3}
                    className="focus-ring w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs"
                    value={marketForm.allowlistRaw}
                    onChange={(e) => setMarketForm((prev) => ({ ...prev, allowlistRaw: e.target.value }))}
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  className="focus-ring h-11 rounded-lg border border-sky-400/60 bg-sky-500/15 px-4 text-sm font-semibold"
                  onClick={createMarketOnChain}
                  disabled={busy.create}
                >
                  {busy.create ? "Creating market..." : "Create Market On-Chain"}
                </button>
                <button
                  type="button"
                  className="focus-ring h-11 rounded-lg border border-slate-700 bg-slate-900 px-4 text-sm font-semibold"
                  onClick={openMarketOnChain}
                  disabled={busy.open}
                >
                  {busy.open ? "Opening..." : "Open Market"}
                </button>
              </div>

              <div className="mt-4 grid gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3 sm:grid-cols-3">
                <Metric label="Current Market ID" value={String(marketForm.marketId || 0)} />
                <Metric label="Deposit" value={formatUsdcMicro(marketForm.orderDepositUnit)} />
                <Metric label="Max Stake" value={formatUsdcMicro(marketForm.maxStakePerOrder)} />
              </div>

              {renderInlineError(errorByAction.create)}
              {renderInlineError(errorByAction.open)}
            </section>
          ) : null}

          {activeStage === "order" ? (
            <section className="rounded-2xl border border-slate-800 bg-[#0f1724] p-4">
              <h2 className="font-display text-2xl">Encrypted Order</h2>
              <p className="mt-1 text-pretty text-sm text-slate-400">
                Encrypt side and stake first, then submit sealed payload on-chain.
              </p>

              <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={encryptAndSubmitOrder}>
                <Field label="Market ID">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={orderForm.marketId}
                    onChange={(e) => setOrderForm((prev) => ({ ...prev, marketId: Number(e.target.value) }))}
                  />
                </Field>
                <Field label="Trader address">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 font-mono text-sm"
                    value={orderForm.trader}
                    onChange={(e) => setOrderForm((prev) => ({ ...prev, trader: e.target.value }))}
                  />
                </Field>

                <Field label="Side">
                  <select
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3"
                    value={orderForm.side}
                    onChange={(e) => setOrderForm((prev) => ({ ...prev, side: Number(e.target.value) }))}
                  >
                    <option value={1}>YES</option>
                    <option value={2}>NO</option>
                  </select>
                </Field>

                <Field label="Stake (USDC micro)">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={orderForm.stake}
                    onChange={(e) => setOrderForm((prev) => ({ ...prev, stake: e.target.value }))}
                  />
                </Field>

                <Field label="Nonce">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={orderForm.nonce}
                    onChange={(e) => setOrderForm((prev) => ({ ...prev, nonce: Number(e.target.value) }))}
                  />
                </Field>

                <div className="flex items-end">
                  <button
                    type="submit"
                    className="focus-ring h-11 w-full rounded-lg border border-sky-400/60 bg-sky-500/15 px-4 text-sm font-semibold"
                    disabled={busy.order}
                  >
                    {busy.order ? "Encrypting + submitting..." : "Encrypt + Submit Order"}
                  </button>
                </div>
              </form>

              {renderInlineError(errorByAction.order)}

              {encryptedOrder ? (
                <ResultBlock title="Encrypted Order Output" payload={encryptedOrder} />
              ) : null}

              <div className="mt-4 space-y-2">
                <h3 className="text-sm font-semibold text-slate-200">Latest Orders</h3>
                {orders.length === 0 ? (
                  <p className="text-sm text-slate-400">No orders submitted yet.</p>
                ) : (
                  orders.slice(0, 6).map((order) => (
                    <div
                      key={order.orderId}
                      className="grid gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 sm:grid-cols-4"
                    >
                      <Metric label="Order" value={`#${order.orderId}`} compact />
                      <Metric label="Trader" value={shortHash(order.trader)} compact />
                      <Metric label="Side" value={SIDE_NAMES[order.side]} compact />
                      <Metric label="Stake" value={formatUsdcMicro(order.stake)} compact />
                    </div>
                  ))
                )}
              </div>
            </section>
          ) : null}

          {activeStage === "batch" ? (
            <section className="rounded-2xl border border-slate-800 bg-[#0f1724] p-4">
              <h2 className="font-display text-2xl">Batch Trigger</h2>
              <p className="mt-1 text-pretty text-sm text-slate-400">
                Submit attested batch close. CTX decrypt callback will process each order.
              </p>

              <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={triggerBatch}>
                <Field label="Market ID">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={batchForm.marketId}
                    onChange={(e) => setBatchForm((prev) => ({ ...prev, marketId: Number(e.target.value) }))}
                  />
                </Field>
                <Field label="Batch ID">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={batchForm.batchId}
                    onChange={(e) => setBatchForm((prev) => ({ ...prev, batchId: Number(e.target.value) }))}
                  />
                </Field>

                <Field className="md:col-span-2" label="Order IDs (comma-separated)">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 font-mono text-sm"
                    value={batchForm.orderIdsRaw}
                    onChange={(e) => setBatchForm((prev) => ({ ...prev, orderIdsRaw: e.target.value }))}
                  />
                </Field>

                <Field label="Expiry (minutes)">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={batchForm.expiryMinutes}
                    onChange={(e) => setBatchForm((prev) => ({ ...prev, expiryMinutes: Number(e.target.value) }))}
                  />
                </Field>
                <Field label="CTX fee (ETH)">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={batchForm.ctxFeeEth}
                    onChange={(e) => setBatchForm((prev) => ({ ...prev, ctxFeeEth: e.target.value }))}
                  />
                </Field>

                <div className="md:col-span-2">
                  <button
                    type="submit"
                    className="focus-ring h-11 w-full rounded-lg border border-sky-400/60 bg-sky-500/15 px-4 text-sm font-semibold"
                    disabled={busy.batch}
                  >
                    {busy.batch ? "Triggering batch..." : "Sign + Trigger Batch CTX"}
                  </button>
                </div>
              </form>

              {renderInlineError(errorByAction.batch)}
              {batchAttestation ? (
                <ResultBlock title="Batch Attestation" payload={batchAttestation} />
              ) : null}
            </section>
          ) : null}

          {activeStage === "resolve" ? (
            <section className="rounded-2xl border border-slate-800 bg-[#0f1724] p-4">
              <h2 className="font-display text-2xl">Resolve + Settle</h2>
              <p className="mt-1 text-pretty text-sm text-slate-400">
                Propose attested outcome, open disputes if needed, then finalize and claim payout.
              </p>

              <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={proposeResolution}>
                <Field label="Market ID">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={resolutionForm.marketId}
                    onChange={(e) =>
                      setResolutionForm((prev) => ({ ...prev, marketId: Number(e.target.value) }))
                    }
                  />
                </Field>

                <Field label="Outcome">
                  <select
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3"
                    value={resolutionForm.outcome}
                    onChange={(e) =>
                      setResolutionForm((prev) => ({ ...prev, outcome: Number(e.target.value) }))
                    }
                  >
                    {OUTCOME_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Evidence hash">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 font-mono text-xs"
                    value={resolutionForm.evidenceHash}
                    onChange={(e) =>
                      setResolutionForm((prev) => ({ ...prev, evidenceHash: e.target.value }))
                    }
                  />
                </Field>

                <Field label="Expiry (minutes)">
                  <input
                    className="focus-ring h-11 rounded-lg border border-slate-800 bg-slate-950 px-3 tabular-nums"
                    value={resolutionForm.expiryMinutes}
                    onChange={(e) =>
                      setResolutionForm((prev) => ({ ...prev, expiryMinutes: Number(e.target.value) }))
                    }
                  />
                </Field>

                <div className="md:col-span-2">
                  <button
                    type="submit"
                    className="focus-ring h-11 w-full rounded-lg border border-sky-400/60 bg-sky-500/15 px-4 text-sm font-semibold"
                    disabled={busy.resolve}
                  >
                    {busy.resolve ? "Proposing..." : "Sign + Propose Resolution"}
                  </button>
                </div>
              </form>

              {resolutionAttestation ? (
                <ResultBlock title="Resolution Attestation" payload={resolutionAttestation} />
              ) : null}

              <div className="mt-4 grid gap-2 md:grid-cols-4">
                <button
                  type="button"
                  className="focus-ring h-11 rounded-lg border border-amber-400/60 bg-amber-500/15 px-3 text-sm font-semibold"
                  onClick={openDispute}
                  disabled={busy.dispute}
                >
                  {busy.dispute ? "Opening..." : "Open Dispute"}
                </button>
                <button
                  type="button"
                  className="focus-ring h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-semibold"
                  onClick={finalizeResolution}
                  disabled={busy.finalize}
                >
                  {busy.finalize ? "Finalizing..." : "Finalize"}
                </button>
                <button
                  type="button"
                  className="focus-ring h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-semibold"
                  onClick={overrideResolution}
                  disabled={busy.finalize}
                >
                  Override
                </button>
                <button
                  type="button"
                  className="focus-ring h-11 rounded-lg border border-emerald-500/60 bg-emerald-500/15 px-3 text-sm font-semibold"
                  onClick={claimPayout}
                  disabled={busy.claim}
                >
                  {busy.claim ? "Claiming..." : "Claim Payout"}
                </button>
              </div>

              {renderInlineError(errorByAction.resolve)}
              {renderInlineError(errorByAction.dispute)}
              {renderInlineError(errorByAction.finalize)}
              {renderInlineError(errorByAction.claim)}
            </section>
          ) : null}

          {activeStage === "receipts" ? (
            <section className="rounded-2xl border border-slate-800 bg-[#0f1724] p-4">
              <h2 className="font-display text-2xl">Receipts</h2>
              <p className="mt-1 text-pretty text-sm text-slate-400">
                Each action emits a structured receipt with execution and reason context.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="focus-ring h-11 rounded-lg border border-slate-700 bg-slate-900 px-4 text-sm font-semibold"
                  onClick={() => {
                    try {
                      syncOnChainReceipts(requireContractAddress(), marketForm.marketId || 0);
                    } catch (error) {
                      setActionError("receipts", toError(error));
                    }
                  }}
                  disabled={busy.receipts}
                >
                  {busy.receipts ? "Syncing..." : "Sync On-Chain Receipts"}
                </button>
                <button
                  type="button"
                  className="focus-ring h-11 rounded-lg border border-slate-700 bg-slate-900 px-4 text-sm font-semibold"
                  onClick={loadDemoReceipts}
                  disabled={busy.receipts}
                >
                  Load Demo Receipts
                </button>
              </div>

              {renderInlineError(errorByAction.receipts)}

              <div className="mt-4 grid gap-3">
                {receipts.length === 0 ? (
                  <EmptyHint
                    title="No receipts yet"
                    detail="Run a batch or load demo receipts to inspect lifecycle evidence."
                    actionLabel="Load demo"
                    onAction={loadDemoReceipts}
                  />
                ) : (
                  receipts.map((receipt) => (
                    <ReceiptCard key={`${receipt.receiptId}-${receipt.timestamp}`} receipt={receipt} />
                  ))
                )}
              </div>
            </section>
          ) : null}
        </main>

        <aside className="h-fit rounded-2xl border border-slate-800 bg-[#0f1724] p-4 xl:sticky xl:top-4">
          {isBoardStage ? (
            <>
              <header className="flex items-center gap-2">
                <div className="size-10 rounded-lg border border-slate-700 bg-slate-900/70" />
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-slate-100">
                    {selectedBoardMarket?.outcomes?.[0]?.label || "YES"}
                  </p>
                  <p className="truncate text-xs text-slate-500">{selectedBoardMarket?.title || "Select a market"}</p>
                </div>
              </header>

              <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-[#111b2f] p-1.5">
                <button
                  type="button"
                  onClick={() => setTradeDirection("buy")}
                  className={cn(
                    "focus-ring h-9 rounded-lg text-sm font-semibold",
                    tradeDirection === "buy" ? "bg-slate-800 text-white" : "text-slate-400"
                  )}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() => setTradeDirection("sell")}
                  className={cn(
                    "focus-ring h-9 rounded-lg text-sm font-semibold",
                    tradeDirection === "sell" ? "bg-slate-800 text-white" : "text-slate-400"
                  )}
                >
                  Sell
                </button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTradeSide(1)}
                  className={cn(
                    "focus-ring h-12 rounded-lg text-base font-semibold",
                    tradeSide === 1
                      ? "border border-emerald-400/60 bg-emerald-500/30 text-emerald-100"
                      : "border border-slate-700 bg-[#1c273a] text-slate-400"
                  )}
                >
                  Yes {Math.max(1, Number(selectedBoardMarket?.outcomes?.[0]?.probability || 50))}¢
                </button>
                <button
                  type="button"
                  onClick={() => setTradeSide(2)}
                  className={cn(
                    "focus-ring h-12 rounded-lg text-base font-semibold",
                    tradeSide === 2
                      ? "border border-rose-400/60 bg-rose-500/30 text-rose-100"
                      : "border border-slate-700 bg-[#1c273a] text-slate-400"
                  )}
                >
                  No {Math.max(1, 100 - Number(selectedBoardMarket?.outcomes?.[0]?.probability || 50))}¢
                </button>
              </div>

              <div className="mt-5">
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-200">Amount</p>
                    <p className="text-xs text-slate-500">Balance $0.00</p>
                  </div>
                  <p className="font-display text-6xl leading-none text-slate-500">${tradeAmount || "0"}</p>
                </div>

                <div className="mt-3 grid grid-cols-4 gap-2">
                  {[1, 20, 100].map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTradeAmount((prev) => String(Number(prev || 0) + value))}
                      className="focus-ring h-10 rounded-lg border border-slate-700 bg-[#1c273a] text-sm font-semibold text-slate-200"
                    >
                      +${value}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setTradeAmount("0")}
                    className="focus-ring h-10 rounded-lg border border-slate-700 bg-[#1c273a] text-sm font-semibold text-slate-200"
                  >
                    Max
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (!selectedBoardMarket) return;
                    const id = Number(selectedBoardMarket.id);
                    setOrderForm((prev) => ({
                      ...prev,
                      marketId: id,
                      side: tradeSide,
                      stake: String(Math.max(1, Number(tradeAmount || 0) * 1_000_000))
                    }));
                    setMarketForm((prev) => ({ ...prev, marketId: id }));
                    setBatchForm((prev) => ({ ...prev, marketId: id }));
                    setResolutionForm((prev) => ({ ...prev, marketId: id }));
                    setActiveStage("order");
                  }}
                  className="focus-ring mt-4 h-12 w-full rounded-xl border border-sky-400/70 bg-sky-500/85 text-lg font-semibold text-white"
                >
                  Trade Securely
                </button>
              </div>

              <p className="mt-4 text-center text-xs text-slate-500">
                Orders stay encrypted until close + valid attestation.
              </p>
            </>
          ) : (
            <>
              <h2 className="font-display text-2xl">Observable Lifecycle</h2>
              <p className="mt-1 text-pretty text-sm text-slate-400">
                Every step should be visible in timeline + receipts + traces.
              </p>

              <ol className="mt-3 space-y-2">
                {timeline.length === 0 ? (
                  <li className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-3 text-sm text-slate-400">
                    No lifecycle events yet.
                  </li>
                ) : (
                  timeline.map((entry) => (
                    <li key={entry.id} className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-3">
                      <p className="font-mono text-xs tabular-nums text-sky-300">{formatTimestamp(entry.ts)}</p>
                      <p className="mt-1 text-pretty text-sm text-slate-100">{entry.message}</p>
                    </li>
                  ))
                )}
              </ol>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function Field({ label, children, className }) {
  return (
    <label className={cn("grid gap-1 text-sm text-slate-300", className)}>
      <span className="text-xs uppercase text-slate-400">{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value, compact = false }) {
  return (
    <div className={cn("rounded-lg border border-slate-800 bg-slate-950 px-3 py-2", compact && "py-1.5")}>
      <p className="text-xs uppercase text-slate-400">{label}</p>
      <p className="mt-1 font-mono text-sm tabular-nums text-slate-100">{value}</p>
    </div>
  );
}

function ResultBlock({ title, payload }) {
  return (
    <section className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
      <pre className="mt-2 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-100">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </section>
  );
}

function MarketBoardCard({ market, selected, onSelect }) {
  const primary = Number(market.outcomes?.[0]?.probability || 50);
  const yesPrice = Math.max(1, primary);
  const noPrice = Math.max(1, 100 - primary);
  const stateLabel = market.state || "OPEN";

  return (
    <article
      className={cn(
        "rounded-xl border bg-[#121c2e] p-3 transition-colors",
        selected ? "border-sky-400/70" : "border-slate-800 hover:border-slate-600"
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-[1.05rem] font-semibold leading-5 text-slate-100">{market.title}</p>
        <span className="shrink-0 rounded-md border border-slate-700 bg-[#0f1626] px-2 py-0.5 font-mono text-[10px] text-slate-400">
          {stateLabel}
        </span>
      </header>

      <div className="mt-3 space-y-2">
        {(market.outcomes || []).slice(0, 2).map((outcome, index) => (
          <div key={`${market.id}-${outcome.label}-${index}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
            <p className="truncate text-sm text-slate-300">{outcome.label}</p>
            <p className="text-right text-2xl font-semibold tabular-nums text-slate-100">{Number(outcome.probability || 0)}%</p>
            <div className="flex items-center gap-1">
              <span className="rounded-md bg-emerald-500/25 px-2 py-1 text-xs font-semibold text-emerald-200">Yes</span>
              <span className="rounded-md bg-rose-500/20 px-2 py-1 text-xs font-semibold text-rose-200">No</span>
            </div>
          </div>
        ))}
      </div>

      <footer className="mt-3 flex items-center justify-between">
        <p className="text-sm text-slate-500">{market.volume}</p>
        <button
          type="button"
          onClick={onSelect}
          className="focus-ring rounded-md border border-slate-700 bg-[#0f1626] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-sky-400/70 hover:text-sky-100"
        >
          Trade {yesPrice}¢ / {noPrice}¢
        </button>
      </footer>
    </article>
  );
}

function ReceiptCard({ receipt }) {
  const tone =
    receipt.status === "SUCCESS"
      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
      : receipt.status === "FAILURE"
        ? "border-rose-500/50 bg-rose-500/10 text-rose-200"
        : "border-amber-400/50 bg-amber-400/10 text-amber-200";

  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <header className="flex items-center justify-between gap-2">
        <p className={cn("rounded-md border px-2 py-1 text-xs font-semibold uppercase", tone)}>{receipt.status}</p>
        <p className="font-mono text-xs tabular-nums text-slate-400">receipt #{receipt.receiptId}</p>
      </header>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Metric label="Market" value={String(receipt.marketId)} compact />
        <Metric label="Order" value={String(receipt.orderId)} compact />
        <Metric label="Trader" value={shortHash(receipt.trader)} compact />
        <Metric label="Reason" value={String(receipt.reasonCode)} compact />
        <Metric label="Side" value={String(receipt.side)} compact />
        <Metric label="Amount" value={formatUsdcMicro(receipt.amount)} compact />
      </div>

      <pre className="mt-3 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-100">
        {JSON.stringify(receipt, null, 2)}
      </pre>
    </article>
  );
}

function EmptyHint({ title, detail, actionLabel, onAction }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-center">
      <p className="text-sm font-semibold text-slate-100">{title}</p>
      <p className="mt-1 text-pretty text-sm text-slate-400">{detail}</p>
      <button
        type="button"
        className="focus-ring mt-3 h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm font-semibold"
        onClick={onAction}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function renderInlineError(error) {
  if (!error) return null;
  return (
    <p className="mt-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
      {error}
    </p>
  );
}

function shortHash(value) {
  if (!value || typeof value !== "string" || value.length < 14) {
    return value || "-";
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function toError(error) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function dedupeReceipts(list) {
  const byKey = new Map();
  for (const receipt of list) {
    const key = `${receipt.receiptId}-${receipt.orderId}`;
    if (!byKey.has(key)) byKey.set(key, receipt);
  }
  return [...byKey.values()].sort((a, b) => Number(b.receiptId) - Number(a.receiptId));
}
