import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { formatUnits } from "viem";
import type { OnchainMarketView } from "@/lib/market-types";
import { claimPayout, EXPECTED_CHAIN_ID, readPosition } from "@/lib/onchain";
import { useQueryClient } from "@tanstack/react-query";
import { ConnectKitButton } from "connectkit";
import { useAccount, useChainId } from "wagmi";

interface ClaimPanelProps {
  market: OnchainMarketView;
}

const OUTCOME_LABELS = ["UNRESOLVED", "YES", "NO", "INVALID"] as const;
const LOT_SIZE_USDC = 10_000n; // 0.01 USDC in micro-units (matches contract LOT_SIZE)
const PRICE_BPS_MAX = 10_000n;

function outcomeLabel(code?: number) {
  if (typeof code !== "number") return "UNRESOLVED";
  return OUTCOME_LABELS[code] || "UNRESOLVED";
}

function formatUsdcShort(amount: bigint) {
  const s = formatUnits(amount, 6);
  const [whole, frac = ""] = s.split(".");
  const two = (frac + "00").slice(0, 2);
  return `${whole}.${two}`;
}

const ClaimPanel = ({ market }: ClaimPanelProps) => {
  const { address } = useAccount();
  const chainId = useChainId();
  const isWrongChain = Boolean(address) && chainId !== EXPECTED_CHAIN_ID;
  const queryClient = useQueryClient();
  const [position, setPosition] = useState<{
    yesLots: bigint;
    noLots: bigint;
    refundable: bigint;
    claimed: boolean;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canClaim = market.state === "RESOLVED";
  const out = outcomeLabel(market.finalOutcomeCode);

  const claimable = useMemo(() => {
    if (!canClaim || !position) return 0n;

    let payout = position.refundable;
    if (out === "YES") {
      payout += position.yesLots * LOT_SIZE_USDC;
    } else if (out === "NO") {
      payout += position.noLots * LOT_SIZE_USDC;
    } else if (out === "INVALID") {
      // Refund the executed costs at the market clearing price.
      const yesCostPerLot = market.clearingYesPriceBps;
      const noCostPerLot = PRICE_BPS_MAX - market.clearingYesPriceBps;
      payout += (position.yesLots * yesCostPerLot) + (position.noLots * noCostPerLot);
    }

    return payout;
  }, [canClaim, market.clearingYesPriceBps, out, position]);

  const hasExposure = Boolean(position) && (position.yesLots > 0n || position.noLots > 0n);
  const winner =
    canClaim &&
    Boolean(position) &&
    ((out === "YES" && position.yesLots > 0n) || (out === "NO" && position.noLots > 0n));

  const resultLabel = useMemo(() => {
    if (!address) return "—";
    if (position?.claimed) return "CLAIMED";
    if (!canClaim) return "SEALED";
    if (out === "INVALID") return "INVALID";
    if (winner) return `WON (${out})`;
    if (hasExposure) return `LOST (${out})`;
    if ((position?.refundable ?? 0n) > 0n) return "REFUND";
    return "—";
  }, [address, canClaim, hasExposure, out, position?.claimed, position?.refundable, winner]);

  const resultTone = useMemo(() => {
    if (resultLabel.startsWith("WON")) return "bg-cm-yes/10 text-cm-yes";
    if (resultLabel.startsWith("LOST")) return "bg-cm-no/10 text-cm-no";
    if (resultLabel === "INVALID") return "bg-primary/10 text-primary";
    if (resultLabel === "REFUND") return "bg-muted text-foreground";
    if (resultLabel === "CLAIMED") return "bg-muted text-foreground";
    return "bg-muted text-foreground";
  }, [resultLabel]);

  async function refreshPosition() {
    if (!address) {
      setPosition(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const p = await readPosition({ marketId: market.id, trader: address });
      setPosition(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read position");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshPosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, market.id, market.state]);

  async function handleClaim() {
    setIsClaiming(true);
    setError(null);
    setStatus(null);
    try {
      if (!canClaim) {
        throw new Error("Market is not resolved yet.");
      }
      if (isWrongChain) {
        throw new Error("Wrong chain selected. Switch to BITE sandbox.");
      }
      if (!address) {
        throw new Error("Connect wallet first");
      }
      const tx = await claimPayout({ marketId: market.id, account: address });
      setStatus(`Payout claimed: ${tx.slice(0, 10)}...`);
      await refreshPosition();
      await queryClient.invalidateQueries({ queryKey: ["onchain-receipts"] });
      await queryClient.invalidateQueries({ queryKey: ["onchain-markets"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed");
    } finally {
      setIsClaiming(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-card-foreground">Claim</h3>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Claims unlock only after the market is resolved (relayer finalizes after the dispute window).
        </p>
      </div>

      <div className="space-y-3 p-4">
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
                  "Connect to Claim"
                )}
              </button>
            )}
          </ConnectKitButton.Custom>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            Loading claim status...
          </div>
        ) : null}

        {address && !isLoading ? (
          <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-xs">
            <span className="text-muted-foreground">Result</span>
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${resultTone}`}>
                {resultLabel}
              </span>
              <span className="font-semibold tabular-nums text-foreground">
                {canClaim ? `${formatUsdcShort(claimable)} USDC` : "SEALED"}
              </span>
            </div>
          </div>
        ) : null}

        {address ? (
          position?.claimed ? (
            <button
              type="button"
              disabled
              className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground opacity-50"
            >
              Already Claimed
            </button>
          ) : !canClaim ? (
            <button
              type="button"
              disabled
              className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground opacity-50"
            >
              Waiting for Resolution
            </button>
          ) : claimable === 0n ? (
            <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              No payout to claim for this wallet.
            </div>
          ) : (
            <button
              type="button"
              onClick={handleClaim}
              disabled={isClaiming || isWrongChain}
              className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {isClaiming ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  Claiming...
                </span>
              ) : winner ? (
                "Claim Winnings"
              ) : (
                "Withdraw"
              )}
            </button>
          )
        ) : null}

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
    </div>
  );
};

export default ClaimPanel;
