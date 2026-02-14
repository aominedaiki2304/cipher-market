export type MarketStateLabel =
  | "CREATED"
  | "OPEN"
  | "ORDER_CTX_REQUESTED"
  | "BATCH_PROCESSED"
  | "OUTCOME_COMMITTED"
  | "OUTCOME_CTX_REQUESTED"
  | "RESOLUTION_PROPOSED"
  | "IN_DISPUTE"
  | "RESOLVED"
  | "CANCELLED";

export interface MarketOutcomeView {
  name: "Yes" | "No";
  probability: number;
  poolAmount: string;
}

export interface OnchainMarketView {
  id: number;
  slug: string;
  title: string;
  questionHash: string;
  category: string;
  image: string;
  outcomes: MarketOutcomeView[];
  volume: string;
  endDate: string;
  type: "binary";
  state: MarketStateLabel;
  stateCode: number;
  finalOutcomeCode: number;
  creator: `0x${string}`;
  collateralToken: `0x${string}`;
  attestor: `0x${string}`;
  approver: `0x${string}`;
  openTime: number;
  closeTime: number;
  resolveBy: number;
  orderDepositUnit: bigint;
  maxStakePerOrder: bigint;
  maxTotalStake: bigint;
  totalEscrowed: bigint;
  totalYesStake: bigint;
  totalNoStake: bigint;
  clearingYesPriceBps: bigint;
  matchedLots: bigint;
  outcomeCommitmentHash: string;
  outcomeCtxSender: `0x${string}`;
  outcomeEvidenceHash: string;
  allowlistEnabled: boolean;
}

export interface OnchainReceiptView {
  receiptId: number;
  marketId: number;
  orderId: number;
  trader: `0x${string}`;
  status: string;
  reasonCode: string;
  side: string;
  amount: string;
  timestamp: number;
  evidenceHash: string;
}
