import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { Share2, Bookmark, BarChart3, Calendar, ArrowUp, ArrowDown, AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import Header from "@/components/Header";
import CategoryNav from "@/components/CategoryNav";
import ChartPlaceholder from "@/components/ChartPlaceholder";
import TradeTicket from "@/components/TradeTicket";
import ClaimPanel from "@/components/ClaimPanel";
import OrderBook from "@/components/OrderBook";
import Receipts from "@/components/Receipts";
import { useOnchainMarkets } from "@/hooks/useOnchainMarkets";
import { Badge } from "@/components/ui/badge";

const MarketDetail = () => {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { data: markets = [], isLoading, error } = useOnchainMarkets();

  const marketId = Number(id);
  const market = useMemo(
    () => markets.find((m) => m.id === marketId) || markets[0],
    [marketId, markets]
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="mx-auto max-w-[1200px] px-4 py-8 text-sm text-muted-foreground">Loading market...</div>
      </div>
    );
  }

  if (error || !market) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="mx-auto max-w-[1200px] px-4 py-8">
          <div className="flex items-center gap-2 rounded-lg border border-cm-no/30 bg-cm-no-light px-4 py-3 text-sm text-cm-no">
            <AlertCircle size={15} />
            {error instanceof Error ? error.message : "Market not found on chain"}
          </div>
        </div>
      </div>
    );
  }

  const categories = ["All", ...new Set(markets.map((m) => m.category))];

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <CategoryNav active={market.category} categories={categories} />

      <div className="mx-auto max-w-[1400px] px-4 py-6">
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="min-w-0 flex-1 space-y-6">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {market.category} · {market.state}
              </p>
              <div className="flex items-start justify-between gap-4">
                <div className="flex gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted text-xl">
                    {market.image}
                  </div>
                  <div>
                    <h1 className="text-xl font-bold text-foreground">{market.title}</h1>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Hash: <code>{market.questionHash}</code>
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted">
                    <Share2 size={16} />
                  </button>
                  <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted">
                    <Bookmark size={16} />
                  </button>
                </div>
              </div>
            </div>

            <ChartPlaceholder market={market} />

            <div className="flex items-center gap-4 text-sm">
              <Badge variant="secondary" className="border-0 bg-primary/10 text-[10px] text-primary">
                ONCHAIN
              </Badge>
              <div className="flex items-center gap-1 text-muted-foreground">
                <BarChart3 size={14} />
                <span className="font-medium">{market.volume} escrowed</span>
              </div>
              <div className="flex items-center gap-1 text-muted-foreground">
                <Calendar size={14} />
                <span>Close: {market.endDate}</span>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card">
              {market.outcomes.map((outcome, i) => (
                <div
                  key={outcome.name}
                  className={`flex items-center gap-4 px-4 py-3 ${
                    i < market.outcomes.length - 1 ? "border-b border-border" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{outcome.name}</p>
                    <p className="text-[11px] text-muted-foreground">{outcome.poolAmount}</p>
                  </div>
                  <span className="text-lg font-bold text-foreground">{outcome.probability}%</span>
                  <span
                    className={`flex items-center gap-0.5 text-xs font-semibold ${
                      outcome.name === "Yes" ? "text-cm-yes" : "text-cm-no"
                    }`}
                  >
                    {outcome.name === "Yes" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                    implied
                  </span>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Rules</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Orders remain encrypted on-chain and execute only after close via attested CTX batch decrypt.
                This market is binary YES/NO and follows the contract policy limits for stake and escrow.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Creator: <code>{market.creator}</code>
              </p>
              <p className="text-xs text-muted-foreground">
                Attestor: <code>{market.attestor}</code>
              </p>
              <p className="text-xs text-muted-foreground">
                Collateral: <code>{market.collateralToken}</code>
              </p>
            </div>

            <OrderBook market={market} />
            <Receipts marketId={market.id} />
          </div>

          <div className="w-full shrink-0 space-y-4 lg:sticky lg:top-20 lg:w-80 lg:self-start">
            <TradeTicket
              market={market}
              onOrderSubmitted={async () => {
                await queryClient.invalidateQueries({ queryKey: ["onchain-markets"] });
                await queryClient.invalidateQueries({ queryKey: ["onchain-receipts"] });
              }}
            />
            <ClaimPanel market={market} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default MarketDetail;
