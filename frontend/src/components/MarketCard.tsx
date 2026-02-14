import { Gift, Bookmark, Share2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { OnchainMarketView } from "@/lib/market-types";
import { cn } from "@/lib/utils";

interface MarketCardProps {
  market: OnchainMarketView;
}

const MarketCard = ({ market }: MarketCardProps) => {
  const yes = market.outcomes.find((o) => o.name === "Yes") || market.outcomes[0];
  const no = market.outcomes.find((o) => o.name === "No") || market.outcomes[1];
  const isClosed =
    market.state !== "OPEN" || (Number.isFinite(market.closeTime) && Math.floor(Date.now() / 1000) >= market.closeTime);

  return (
    <Link
      to={`/market/${market.id}`}
      className="group relative block overflow-hidden rounded-lg border border-border bg-card transition-all duration-200 hover:shadow-md"
    >
      <div className={cn("p-4", isClosed && "opacity-60 grayscale")}>
        <div className="mb-3 flex gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">
            {market.image}
          </div>
          <div className="min-w-0">
            <h3 className="line-clamp-2 text-sm font-semibold leading-tight text-card-foreground transition-colors group-hover:text-primary">
              {market.title}
            </h3>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {market.state} · id {market.id}
            </p>
          </div>
        </div>

        <div>
          <div className="mb-2 text-center">
            <span className="text-3xl font-bold text-foreground">{yes.probability}%</span>
            <span className="ml-1 text-sm text-muted-foreground">yes</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={(e) => e.preventDefault()}
              className="flex-1 rounded-lg border-2 border-cm-yes bg-cm-yes-light py-2 text-center text-sm font-semibold text-cm-yes transition-colors hover:bg-cm-yes hover:text-primary-foreground"
            >
              Yes
            </button>
            <button
              onClick={(e) => e.preventDefault()}
              className="flex-1 rounded-lg border-2 border-cm-no bg-cm-no-light py-2 text-center text-sm font-semibold text-cm-no transition-colors hover:bg-cm-no hover:text-primary-foreground"
            >
              No {no?.probability ?? 0}%
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <span className="text-xs font-medium text-muted-foreground">{market.volume}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => e.preventDefault()}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
            >
              <Gift size={13} />
            </button>
            <button
              onClick={(e) => e.preventDefault()}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
            >
              <Share2 size={13} />
            </button>
            <button
              onClick={(e) => e.preventDefault()}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
            >
              <Bookmark size={13} />
            </button>
          </div>
        </div>
      </div>

      {isClosed ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="select-none rotate-[-18deg] text-5xl font-black text-cm-no/35">CLOSED</span>
        </div>
      ) : null}
    </Link>
  );
};

export default MarketCard;
