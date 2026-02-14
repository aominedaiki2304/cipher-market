import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Search } from "lucide-react";
import { formatUnits, type Address } from "viem";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import Header from "@/components/Header";
import { ConnectKitButton } from "connectkit";
import { useAccount, useChainId } from "wagmi";
import {
  claimPayout,
  DEFAULT_USDC,
  EXPECTED_CHAIN_ID,
  readPosition,
  readTokenBalance,
  readTraderOrdersInMarket
} from "@/lib/onchain";
import type { OnchainMarketView } from "@/lib/market-types";
import { cn } from "@/lib/utils";
import { useOnchainMarkets } from "@/hooks/useOnchainMarkets";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

type PortfolioRow = {
  market: OnchainMarketView;
  position: {
    yesLots: bigint;
    noLots: bigint;
    refundable: bigint;
    claimed: boolean;
  };
  orders: Array<{
    orderId: number;
    createdAt: number;
    processed: boolean;
    sideCode: number;
    stake: bigint;
  }>;
};

const OUTCOME_LABELS = ["UNRESOLVED", "YES", "NO", "INVALID"] as const;
const LOT_SIZE_USDC = 10_000n; // 0.01 USDC in micro-units (matches contract LOT_SIZE)

function outcomeLabel(code?: number) {
  if (typeof code !== "number") return "UNRESOLVED";
  return OUTCOME_LABELS[code] || "UNRESOLVED";
}

function formatUsdc(amount: bigint) {
  const s = formatUnits(amount, 6);
  const [whole, frac = ""] = s.split(".");
  const two = (frac + "00").slice(0, 2);
  return `${whole}.${two}`;
}

function computeExpectedPayout(market: OnchainMarketView, position: PortfolioRow["position"]) {
  if (market.state !== "RESOLVED") return 0n;

  const out = outcomeLabel(market.finalOutcomeCode);
  let payout = position.refundable;

  if (out === "YES") {
    payout += position.yesLots * LOT_SIZE_USDC;
  } else if (out === "NO") {
    payout += position.noLots * LOT_SIZE_USDC;
  } else if (out === "INVALID") {
    // Refund the executed costs at the market clearing price.
    const yesCostPerLot = market.clearingYesPriceBps;
    const noCostPerLot = 10_000n - market.clearingYesPriceBps;
    payout += (position.yesLots * yesCostPerLot) + (position.noLots * noCostPerLot);
  }

  return payout;
}

function positionCostMicro(market: OnchainMarketView, position: PortfolioRow["position"]) {
  // Only meaningful after the batch clears and sets the clearing price.
  const yesCostPerLot = market.clearingYesPriceBps;
  const noCostPerLot = 10_000n - market.clearingYesPriceBps;
  return (position.yesLots * yesCostPerLot) + (position.noLots * noCostPerLot);
}

function betLabel(position: PortfolioRow["position"]) {
  const yes = position.yesLots > 0n;
  const no = position.noLots > 0n;
  if (yes && no) return "BOTH";
  if (yes) return "YES";
  if (no) return "NO";
  if (position.refundable > 0n) return "REFUND";
  return "—";
}

const PORTFOLIO_SCAN_LIMIT = 60;

const Portfolio = () => {
  const { address } = useAccount();
  const chainId = useChainId();
  const isWrongChain = Boolean(address) && chainId !== EXPECTED_CHAIN_ID;
  const queryClient = useQueryClient();
  const { data: markets = [], isLoading: isLoadingMarkets, error: marketsError } = useOnchainMarkets();
  const [tab, setTab] = useState<"positions" | "history">("positions");
  const [search, setSearch] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const scanMarkets = useMemo(() => markets.slice(0, PORTFOLIO_SCAN_LIMIT), [markets]);

  const { data: rows = [], isLoading: isLoadingPositions } = useQuery({
    queryKey: ["portfolio-positions", address, scanMarkets.map((m) => m.id).join(",")],
    enabled: Boolean(address) && scanMarkets.length > 0,
    queryFn: async () => {
      const trader = address as Address;
      const results = await Promise.all(
        scanMarkets.map(async (m) => {
          const [position, orders] = await Promise.all([
            readPosition({ marketId: m.id, trader }),
            readTraderOrdersInMarket({ marketId: m.id, trader }).catch(() => [])
          ]);
          return { market: m, position, orders } satisfies PortfolioRow;
        })
      );

      return results.filter((r) => {
        const hasPosition =
          r.position.yesLots > 0n ||
          r.position.noLots > 0n ||
          r.position.refundable > 0n ||
          r.position.claimed;
        return hasPosition || r.orders.length > 0;
      });
    },
    refetchInterval: 15_000
  });

  const activeRows = useMemo(
    () => rows.filter((r) => r.market.state !== "RESOLVED" && r.market.state !== "CANCELLED"),
    [rows]
  );
  const historyRows = useMemo(
    () => rows.filter((r) => r.market.state === "RESOLVED" || r.market.state === "CANCELLED"),
    [rows]
  );

  const visibleRows = useMemo(() => (tab === "positions" ? activeRows : historyRows), [activeRows, historyRows, tab]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleRows;
    return visibleRows.filter((r) => r.market.title.toLowerCase().includes(q) || String(r.market.id).includes(q));
  }, [visibleRows, search]);

  const totals = useMemo(() => {
    let claimable = 0n;
    let refundable = 0n;
    for (const r of rows) {
      refundable += r.position.refundable;
      if (!r.position.claimed) {
        claimable += computeExpectedPayout(r.market, r.position);
      }
    }
    return { claimable, refundable };
  }, [rows]);

  async function refreshBalance() {
    if (!address) {
      setBalance(null);
      return;
    }
    setIsLoadingBalance(true);
    try {
      const next = await readTokenBalance({ owner: address as Address, token: DEFAULT_USDC });
      setBalance(next);
    } catch (_err) {
      setBalance(null);
    } finally {
      setIsLoadingBalance(false);
    }
  }

  useEffect(() => {
    void refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, markets.length]);

  async function handleClaim(row: PortfolioRow) {
    setActionStatus(null);
    setActionError(null);
    try {
      if (isWrongChain) throw new Error("Wrong chain selected. Switch to BITE sandbox.");
      if (!address) throw new Error("Connect wallet first");
      const account = address as Address;
      const tx = await claimPayout({ marketId: row.market.id, account });
      setActionStatus(`Claim confirmed: ${tx.slice(0, 10)}...`);
      await queryClient.invalidateQueries({ queryKey: ["portfolio-positions"] });
      await queryClient.invalidateQueries({ queryKey: ["onchain-markets"] });
      await queryClient.invalidateQueries({ queryKey: ["onchain-receipts"] });
      void refreshBalance();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Claim failed");
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="mx-auto max-w-[1400px] px-4 py-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-balance text-2xl font-bold text-foreground">Portfolio</h1>
            <p className="text-pretty text-sm text-muted-foreground">
              Your encrypted market activity. Orders are private until batch close, then positions become claimable after
              resolution.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {!address ? (
              <ConnectKitButton.Custom>
                {({ show, isConnecting }) => (
                  <button
                    type="button"
                    onClick={() => show?.()}
                    disabled={Boolean(isConnecting)}
                    className="h-9 rounded-full border border-border px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                  >
                    {isConnecting ? "Connecting..." : "Connect to view"}
                  </button>
                )}
              </ConnectKitButton.Custom>
            ) : null}
          </div>
        </div>

        {marketsError ? (
          <div className="mt-6 flex items-center gap-2 rounded-lg border border-cm-no/30 bg-cm-no-light px-4 py-3 text-sm text-cm-no">
            <AlertCircle size={15} />
            {marketsError instanceof Error ? marketsError.message : "Failed to load markets"}
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">USDC balance</p>
            <p className="mt-2 text-3xl font-bold tabular-nums text-foreground">
              {address ? (isLoadingBalance ? "…" : balance === null ? "—" : `$${formatUsdc(balance)}`) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Wallet funds available to trade.</p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Pending payout (est.)</p>
            <p className="mt-2 text-3xl font-bold tabular-nums text-foreground">
              {address ? (isLoadingPositions ? "…" : `$${formatUsdc(totals.claimable)}`) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Shown after resolution. Includes refunds. Claim button appears only if you won.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">Positions tracked</p>
            <p className="mt-2 text-3xl font-bold tabular-nums text-foreground">
              {address ? (isLoadingPositions ? "…" : String(rows.length)) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Markets where your stake or refundable amount is recorded on-chain.
            </p>
          </div>
        </div>

        <div className="mt-6 rounded-lg border border-border bg-card">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "positions" | "history")}>
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <TabsList className="h-auto gap-6 bg-transparent p-0 text-muted-foreground">
                  <TabsTrigger
                    value="positions"
                    className="rounded-none border-b-2 border-transparent bg-transparent px-0 py-1.5 text-sm data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Positions
                  </TabsTrigger>
                  <TabsTrigger
                    value="history"
                    className="rounded-none border-b-2 border-transparent bg-transparent px-0 py-1.5 text-sm data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    History
                  </TabsTrigger>
                </TabsList>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {tab === "positions"
                    ? "Active markets only. Your side and stake stay encrypted until batch close."
                    : "Resolved markets. Claim appears only if you won."}
                </p>
              </div>

              <div className="relative w-full sm:w-80">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={tab === "positions" ? "Search positions" : "Search history"}
                  className="h-9 w-full rounded-full border border-border bg-muted/40 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                />
              </div>
            </div>

            {!address ? (
              <div className="p-6 text-sm text-muted-foreground">
                Connect your wallet to see your positions and history.
              </div>
            ) : isLoadingMarkets || isLoadingPositions ? (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 size={16} className="animate-spin" />
                Loading portfolio…
              </div>
            ) : (
              <>
                <TabsContent value="positions" className="m-0">
                  {filteredRows.length === 0 ? (
                    <div className="p-6 text-sm text-muted-foreground">
                      No active positions. Place an order on any open market.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs text-muted-foreground">
                          <tr className="border-b border-border">
                            <th className="px-4 py-3 text-left font-semibold">Market</th>
                            <th className="px-4 py-3 text-left font-semibold">Bet</th>
                            <th className="px-4 py-3 text-right font-semibold">Stake</th>
                            <th className="px-4 py-3 text-left font-semibold">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {filteredRows.map((row) => {
                            const isDecrypted = row.market.stateCode >= 3; // BATCH_PROCESSED+
                            const bet = isDecrypted ? betLabel(row.position) : "SEALED";
                            const cost = isDecrypted ? positionCostMicro(row.market, row.position) : 0n;

                            return (
                              <tr key={row.market.id} className="hover:bg-muted/30">
                                <td className="px-4 py-3">
                                  <div className="min-w-0">
                                    <Link
                                      to={`/market/${row.market.id}`}
                                      className="block truncate font-semibold text-foreground hover:text-primary"
                                    >
                                      {row.market.title}
                                    </Link>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                                      {row.market.state} · closes {row.market.endDate}
                                    </p>
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-xs font-semibold text-foreground">{bet}</td>
                                <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-foreground">
                                  {isDecrypted ? `${formatUsdc(cost)} USDC` : "SEALED"}
                                </td>
                                <td className="px-4 py-3">
                                  <span className="inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                                    {row.market.state}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="history" className="m-0">
                  {filteredRows.length === 0 ? (
                    <div className="p-6 text-sm text-muted-foreground">No history yet.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs text-muted-foreground">
                          <tr className="border-b border-border">
                            <th className="px-4 py-3 text-left font-semibold">Market</th>
                            <th className="px-4 py-3 text-left font-semibold">Bet</th>
                            <th className="px-4 py-3 text-right font-semibold">Stake</th>
                            <th className="px-4 py-3 text-right font-semibold">Payout</th>
                            <th className="px-4 py-3 text-left font-semibold">Status</th>
                            <th className="px-4 py-3 text-right font-semibold">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {filteredRows.map((row) => {
                            const out = outcomeLabel(row.market.finalOutcomeCode);
                            const hasExposure = row.position.yesLots > 0n || row.position.noLots > 0n;
                            const winner =
                              row.market.state === "RESOLVED" &&
                              ((out === "YES" && row.position.yesLots > 0n) || (out === "NO" && row.position.noLots > 0n));
                            const claimable = computeExpectedPayout(row.market, row.position);
                            const cost = positionCostMicro(row.market, row.position);
                            const showAction = row.market.state === "RESOLVED" && claimable > 0n;

                            return (
                              <tr key={row.market.id} className="hover:bg-muted/30">
                                <td className="px-4 py-3">
                                  <div className="min-w-0">
                                    <Link
                                      to={`/market/${row.market.id}`}
                                      className="block truncate font-semibold text-foreground hover:text-primary"
                                    >
                                      {row.market.title}
                                    </Link>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                                      {row.market.state} · closed {row.market.endDate}
                                    </p>
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-xs font-semibold text-foreground">{betLabel(row.position)}</td>
                                <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-foreground">
                                  {cost > 0n ? `${formatUsdc(cost)} USDC` : "—"}
                                </td>
                                <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-foreground">
                                  {row.market.state === "RESOLVED" ? `${formatUsdc(claimable)} USDC` : "—"}
                                </td>
                                <td className="px-4 py-3">
                                  <span
                                    className={cn(
                                      "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold",
                                      row.position.claimed
                                        ? "bg-muted text-foreground"
                                        : winner
                                          ? "bg-cm-yes/10 text-cm-yes"
                                          : out === "INVALID" || !hasExposure
                                            ? "bg-primary/10 text-primary"
                                            : "bg-cm-no/10 text-cm-no"
                                    )}
                                  >
                                    {row.position.claimed
                                      ? "CLAIMED"
                                      : winner
                                        ? `WON (${out})`
                                        : out === "INVALID"
                                          ? "INVALID"
                                          : hasExposure
                                            ? `LOST (${out})`
                                            : row.position.refundable > 0n
                                              ? "REFUND"
                                              : "—"}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right">
                                  {row.position.claimed ? (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  ) : showAction && winner ? (
                                    <button
                                      type="button"
                                      onClick={() => handleClaim(row)}
                                      className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                                    >
                                      Claim
                                    </button>
                                  ) : showAction && row.position.refundable > 0n ? (
                                    <button
                                      type="button"
                                      onClick={() => handleClaim(row)}
                                      className="rounded-full border border-border bg-background px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
                                    >
                                      Withdraw
                                    </button>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </TabsContent>
              </>
            )}
          </Tabs>
        </div>

        {actionStatus ? (
          <div className="mt-4 rounded-lg border border-cm-yes/40 bg-cm-yes-light px-4 py-3 text-sm text-cm-yes">
            {actionStatus}
          </div>
        ) : null}
        {actionError ? (
          <div className="mt-4 rounded-lg border border-cm-no/40 bg-cm-no-light px-4 py-3 text-sm text-cm-no">
            {actionError}
          </div>
        ) : null}
      </main>
    </div>
  );
};

export default Portfolio;
