import { useMemo, useState } from "react";
import Header from "@/components/Header";
import CategoryNav from "@/components/CategoryNav";
import FilterRow from "@/components/FilterRow";
import MarketCard from "@/components/MarketCard";
import { useOnchainMarkets } from "@/hooks/useOnchainMarkets";
import { AlertCircle, Loader2 } from "lucide-react";

const Index = () => {
  const { data: markets = [], isLoading, error } = useOnchainMarkets();
  const [activeCategory, setActiveCategory] = useState("All");

  const categories = useMemo(() => {
    return ["All", ...new Set(markets.map((m) => m.category))];
  }, [markets]);

  const visibleMarkets = useMemo(() => {
    return markets.filter((market) => {
      if (activeCategory !== "All" && market.category !== activeCategory) {
        return false;
      }
      return true;
    });
  }, [activeCategory, markets]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <CategoryNav active={activeCategory} categories={categories} onSelect={setActiveCategory} />
      <FilterRow />

      <main className="mx-auto max-w-[1400px] px-4 pb-8">
        {isLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" />
            Loading on-chain markets...
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 rounded-lg border border-cm-no/30 bg-cm-no-light px-4 py-3 text-sm text-cm-no">
            <AlertCircle size={15} />
            {error instanceof Error ? error.message : "Failed to load on-chain markets"}
          </div>
        ) : visibleMarkets.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
            No on-chain markets yet. The background relayer will create demo markets periodically.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleMarkets.map((market) => (
              <MarketCard key={market.id} market={market} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default Index;
