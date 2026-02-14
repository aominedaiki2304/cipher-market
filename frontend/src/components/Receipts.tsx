import { useOnchainReceipts } from "@/hooks/useOnchainMarkets";

const statusColors: Record<string, string> = {
  SUCCESS: "bg-cm-yes/10 text-cm-yes",
  PENDING: "bg-primary/10 text-primary",
  FAILURE: "bg-cm-no/10 text-cm-no"
};

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTime(unix: number) {
  if (!unix) return "-";
  return new Date(unix * 1000).toLocaleString();
}

interface ReceiptsProps {
  marketId?: number;
}

const Receipts = ({ marketId }: ReceiptsProps) => {
  const { data: receipts = [], isLoading } = useOnchainReceipts(marketId, 15);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-card-foreground">On-Chain Receipts</h3>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading receipts...</div>
      ) : receipts.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">No on-chain receipts yet</div>
      ) : (
        <div className="divide-y divide-border">
          {receipts.map((r) => (
            <div key={r.receiptId} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-foreground">#{r.receiptId}</span>
                  <span className="text-xs text-muted-foreground">{r.side}</span>
                  <span className="truncate text-sm text-foreground">{r.reasonCode}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {shortAddress(r.trader)} · {r.amount} USDC · {formatTime(r.timestamp)}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  statusColors[r.status] || "bg-muted text-foreground"
                }`}
              >
                {r.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Receipts;
