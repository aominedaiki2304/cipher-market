import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Loader2 } from "lucide-react";
import { formatUnits } from "viem";
import type { OnchainMarketView } from "@/lib/market-types";
import {
  approveDeposit,
  EXPECTED_CHAIN_ID,
  PRIVATE_PREDICTION_MARKET_ADDRESS,
  readAllowance,
  readTokenBalance,
  submitEncryptedOrder,
  toStakeUnits
} from "@/lib/onchain";
import { ConnectKitButton } from "connectkit";
import { useAccount, useChainId } from "wagmi";

interface TradeTicketProps {
  market: OnchainMarketView;
  onOrderSubmitted?: () => Promise<void> | void;
}

const MIN_STAKE_USDC = 1_000_000n; // 1 USDC (6 decimals)

const TradeTicket = ({ market, onOrderSubmitted }: TradeTicketProps) => {
  const { address } = useAccount();
  const chainId = useChainId();
  const isWrongChain = Boolean(address) && chainId !== EXPECTED_CHAIN_ID;
  const [selectedOutcome, setSelectedOutcome] = useState<"yes" | "no">("yes");
  const [amount, setAmount] = useState("0");
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [isCheckingBalance, setIsCheckingBalance] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const yesOutcome = market.outcomes.find((o) => o.name === "Yes") || market.outcomes[0];
  const noOutcome = market.outcomes.find((o) => o.name === "No") || market.outcomes[1];
  const requiredDeposit = market.orderDepositUnit;

  const stakePreview = useMemo(() => {
    try {
      return toStakeUnits(amount);
    } catch (_error) {
      return -1n;
    }
  }, [amount]);

  const canTrade = market.state === "OPEN";
  const hasAllowance = allowance >= requiredDeposit;
  const hasValidStake =
    stakePreview >= MIN_STAKE_USDC &&
    stakePreview <= market.maxStakePerOrder &&
    stakePreview <= market.orderDepositUnit;

  const balanceLabel = useMemo(() => {
    if (!address) return "—";
    if (isCheckingBalance) return "...";
    if (balance === null) return "—";
    // Keep it short and Polymarket-like: 2 decimals.
    const s = formatUnits(balance, 6);
    const [whole, frac = ""] = s.split(".");
    const two = (frac + "00").slice(0, 2);
    return `${whole}.${two}`;
  }, [address, balance, isCheckingBalance]);

  async function refreshAllowance() {
    if (!address) {
      setAllowance(0n);
      return;
    }
    setError(null);
    try {
      const next = await readAllowance({
        owner: address,
        token: market.collateralToken,
        spender: PRIVATE_PREDICTION_MARKET_ADDRESS
      });
      setAllowance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read allowance");
    }
  }

  async function refreshBalance() {
    if (!address) {
      setBalance(null);
      return;
    }
    setIsCheckingBalance(true);
    try {
      const next = await readTokenBalance({
        owner: address,
        token: market.collateralToken
      });
      setBalance(next);
    } catch (_err) {
      setBalance(null);
    } finally {
      setIsCheckingBalance(false);
    }
  }

  useEffect(() => {
    if (!address) return;
    void refreshAllowance();
    void refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, market.id, market.collateralToken]);

  async function handleApprove() {
    setIsApproving(true);
    setError(null);
    setStatus(null);
    try {
      if (!address) {
        throw new Error("Connect wallet first");
      }
      const account = address;
      const tx = await approveDeposit({
        account,
        token: market.collateralToken,
        spender: PRIVATE_PREDICTION_MARKET_ADDRESS,
        amount: requiredDeposit
      });
      setStatus(`USDC approval confirmed: ${tx.slice(0, 10)}...`);
      await refreshAllowance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval failed");
    } finally {
      setIsApproving(false);
    }
  }

  async function handleSubmitOrder() {
    setIsSubmitting(true);
    setError(null);
    setStatus(null);

    try {
      if (!canTrade) {
        throw new Error(`Market is ${market.state}. Orders allowed only in OPEN state.`);
      }
      if (isWrongChain) {
        throw new Error("Wrong chain selected. Switch to BITE sandbox.");
      }
      if (!address) {
        throw new Error("Connect wallet first.");
      }
      if (!hasValidStake) {
        throw new Error(
          `Stake must be between 1 and ${formatUnits(market.maxStakePerOrder, 6)} USDC (and <= deposit).`
        );
      }
      if (!hasAllowance) {
        throw new Error("Approve USDC deposit first.");
      }

      const tx = await submitEncryptedOrder({
        marketId: market.id,
        account: address,
        side: selectedOutcome === "yes" ? 1 : 2,
        stake: stakePreview,
        // Keep UI simple for the demo: always submit with a permissive limit.
        // (Still sealed + cleared in a batch on-chain.)
        limitPriceBps: 10_000
      });
      setStatus(`Encrypted order submitted on-chain: ${tx.slice(0, 10)}...`);
      void refreshBalance();
      if (onOrderSubmitted) {
        await onOrderSubmitted();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Order submission failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <aside className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-sm">
          {market.image}
        </div>
        <span className="truncate text-sm font-semibold text-card-foreground">
          {market.title || `Market #${market.id}`}
        </span>
      </div>

      <div className="flex items-center justify-between border-b border-border px-4">
        <div className="flex">
          <button className="border-b-2 border-foreground px-4 py-3 text-sm font-semibold text-foreground">
            Buy
          </button>
        </div>
        <button className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
          Encrypted <ChevronDown size={14} />
        </button>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex gap-2">
          <button
            onClick={() => setSelectedOutcome("yes")}
            className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
              selectedOutcome === "yes"
                ? "bg-cm-yes text-primary-foreground"
                : "border-2 border-border text-muted-foreground hover:border-cm-yes hover:text-cm-yes"
            }`}
          >
            Yes {yesOutcome?.probability ?? 50}%
          </button>
          <button
            onClick={() => setSelectedOutcome("no")}
            className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
              selectedOutcome === "no"
                ? "bg-cm-no text-primary-foreground"
                : "border-2 border-border text-muted-foreground hover:border-cm-no hover:text-cm-no"
            }`}
          >
            No {noOutcome?.probability ?? 50}%
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">Stake (USDC)</label>
            <span className="text-[11px] text-muted-foreground">Balance {balanceLabel} USDC</span>
          </div>
          <div className="mt-1 flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span className="text-sm text-muted-foreground">$</span>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full bg-transparent text-right text-2xl font-bold text-foreground outline-none"
            />
          </div>
        </div>

        {!address ? (
          <ConnectKitButton.Custom>
            {({ show, isConnecting }) => (
              <button
                type="button"
                onClick={() => show?.()}
                disabled={Boolean(isConnecting)}
                className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {isConnecting ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" />
                    Connecting...
                  </span>
                ) : (
                  "Connect to Trade"
                )}
              </button>
            )}
          </ConnectKitButton.Custom>
        ) : (
          <>
            <button
              type="button"
              onClick={handleApprove}
              disabled={isApproving || hasAllowance}
              className="w-full rounded-md border border-border py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {hasAllowance ? "Deposit Approved" : isApproving ? "Approving..." : "Approve Deposit"}
            </button>

            <button
              type="button"
              onClick={handleSubmitOrder}
              disabled={isSubmitting || !hasValidStake}
              className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {isSubmitting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  Submitting Encrypted Order...
                </span>
              ) : (
                `Submit ${selectedOutcome === "yes" ? "YES" : "NO"} Order`
              )}
            </button>
          </>
        )}

        {status ? (
          <div className="flex items-center gap-2 rounded-md border border-cm-yes/40 bg-cm-yes-light px-3 py-2 text-xs text-cm-yes">
            <CheckCircle2 size={14} />
            <span>{status}</span>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-cm-no/40 bg-cm-no-light px-3 py-2 text-xs text-cm-no">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </aside>
  );
};

export default TradeTicket;
