import type { OnchainMarketView } from "@/lib/market-types";

interface ChartPlaceholderProps {
  market: OnchainMarketView;
}

function formatUnix(unix: number) {
  return new Date(unix * 1000).toLocaleString();
}

const ChartPlaceholder = ({ market }: ChartPlaceholderProps) => {
  const now = Math.floor(Date.now() / 1000);
  const rangeStart = market.openTime || now;
  const rangeEnd = Math.max(market.resolveBy, rangeStart + 1);
  const pct = Math.max(0, Math.min(100, ((now - rangeStart) / (rangeEnd - rangeStart)) * 100));

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Lifecycle Timeline</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Sealed batch markets do not expose pre-decrypt orderflow; use on-chain timestamps and receipts for lifecycle evidence.
      </p>

      <div className="mt-4 h-2 rounded bg-muted">
        <div className="h-2 rounded bg-primary" style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <p className="font-semibold text-foreground">Open</p>
          <p>{formatUnix(market.openTime)}</p>
        </div>
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <p className="font-semibold text-foreground">Close</p>
          <p>{formatUnix(market.closeTime)}</p>
        </div>
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <p className="font-semibold text-foreground">Resolve By</p>
          <p>{formatUnix(market.resolveBy)}</p>
        </div>
      </div>
    </div>
  );
};

export default ChartPlaceholder;
