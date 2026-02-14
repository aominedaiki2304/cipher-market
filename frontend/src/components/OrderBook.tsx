import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { useState } from "react";
import { formatUnits } from "viem";
import type { OnchainMarketView } from "@/lib/market-types";

interface OrderBookProps {
  market: OnchainMarketView;
}

const OrderBook = ({ market }: OrderBookProps) => {
  const [expanded, setExpanded] = useState(true);

  const yesPool = Number(formatUnits(market.totalYesStake, 6));
  const noPool = Number(formatUnits(market.totalNoStake, 6));
  const total = yesPool + noPool;
  const yesShare = total > 0 ? (yesPool / total) * 100 : 50;
  const noShare = 100 - yesShare;

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-card-foreground"
      >
        <div className="flex items-center gap-2">
          Pool Snapshot
          <Info size={14} className="text-muted-foreground" />
        </div>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {expanded ? (
        <div className="space-y-3 px-4 pb-4">
          <p className="text-[11px] text-muted-foreground">
            Sealed batch model: no public live order book pre-decrypt. This panel shows on-chain pooled stake only.
          </p>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-cm-yes">YES Pool</span>
              <span className="text-foreground">{yesPool.toFixed(3)} USDC</span>
            </div>
            <div className="h-2 rounded bg-muted">
              <div
                className="h-2 rounded bg-cm-yes"
                style={{ width: `${Math.max(0, Math.min(100, yesShare))}%` }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-cm-no">NO Pool</span>
              <span className="text-foreground">{noPool.toFixed(3)} USDC</span>
            </div>
            <div className="h-2 rounded bg-muted">
              <div
                className="h-2 rounded bg-cm-no"
                style={{ width: `${Math.max(0, Math.min(100, noShare))}%` }}
              />
            </div>
          </div>

          <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>Escrowed</span>
              <span>{Number(formatUnits(market.totalEscrowed, 6)).toFixed(3)} USDC</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span>State</span>
              <span>{market.state}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default OrderBook;
