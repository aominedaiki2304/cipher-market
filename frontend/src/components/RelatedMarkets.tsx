import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { OnchainMarketView } from "@/lib/market-types";

interface RelatedMarketsProps {
  markets: OnchainMarketView[];
  currentMarketId: number;
}

const RelatedMarkets = ({ markets, currentMarketId }: RelatedMarketsProps) => {
  const [tab, setTab] = useState<"all" | "open">("all");

  const filtered = useMemo(() => {
    return markets
      .filter((m) => m.id !== currentMarketId)
      .filter((m) => (tab === "open" ? m.state === "OPEN" : true))
      .slice(0, 8);
  }, [currentMarketId, markets, tab]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        {(["all", "open"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition-colors ${
              tab === t ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">No related on-chain markets yet.</div>
      ) : (
        <div className="divide-y divide-border">
          {filtered.map((rm) => (
            <Link
              key={rm.id}
              to={`/market/${rm.id}`}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-sm">
                {rm.image}
              </div>
              <span className="flex-1 truncate text-sm text-foreground">{rm.title}</span>
              <span className="shrink-0 text-sm font-bold text-foreground">{rm.outcomes[0]?.probability ?? 50}%</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
};

export default RelatedMarkets;
