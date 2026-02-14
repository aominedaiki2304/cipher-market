import { useQuery } from "@tanstack/react-query";
import { fetchOnchainMarkets, fetchOnchainReceipts } from "@/lib/onchain";

export function useOnchainMarkets() {
  return useQuery({
    queryKey: ["onchain-markets"],
    queryFn: fetchOnchainMarkets,
    // Avoid blanking the UI while refetching; keep prior data.
    placeholderData: (prev) => prev,
    staleTime: 10_000,
    refetchInterval: 15_000
  });
}

export function useOnchainReceipts(marketId?: number, limit = 20) {
  return useQuery({
    queryKey: ["onchain-receipts", marketId, limit],
    queryFn: () => fetchOnchainReceipts({ marketId, limit }),
    refetchInterval: 15_000
  });
}
