import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, PlusCircle } from "lucide-react";
import type { Address } from "viem";
import { ConnectKitButton } from "connectkit";
import { useAccount, useChainId } from "wagmi";
import { createAndOpenMarket, API_BASE_URL, EXPECTED_CHAIN_ID } from "@/lib/onchain";

function shorten(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const CreateMarketPanel = () => {
  const { address } = useAccount();
  const chainId = useChainId();
  const isWrongChain = Boolean(address) && chainId !== EXPECTED_CHAIN_ID;
  const queryClient = useQueryClient();

  const [question, setQuestion] = useState("Fed decision in March?");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: health } = useQuery({
    queryKey: ["api-health"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/health`);
      if (!res.ok) throw new Error("API health unavailable");
      return res.json() as Promise<{
        attestorAddress?: string;
      }>;
    },
    retry: false
  });

  async function handleCreate() {
    setError(null);
    setStatus(null);
    setIsSubmitting(true);

    try {
      if (!address) throw new Error("Connect wallet first");
      if (isWrongChain) throw new Error("Wrong chain selected. Switch to BITE sandbox.");
      const account = address;

      const attestor =
        (health?.attestorAddress as Address | undefined) || (account as Address);

      const result = await createAndOpenMarket({
        account: account as Address,
        question,
        attestor,
        approver: account as Address
      });

      setStatus(
        `Created market #${result.marketId}. tx ${shorten(result.createTxHash)}.`
      );
      await queryClient.invalidateQueries({ queryKey: ["onchain-markets"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create market");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="mb-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-card-foreground">Create On-Chain Market</h2>
          <p className="text-xs text-muted-foreground">
            This creates and opens a real market on the deployed `PrivatePredictionMarket` contract.
          </p>
        </div>
        {address ? (
          <button
            type="button"
            onClick={handleCreate}
            disabled={isSubmitting}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
          >
            {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <PlusCircle size={14} />}
            {isSubmitting ? "Creating..." : "Create Market"}
          </button>
        ) : (
          <ConnectKitButton.Custom>
            {({ show, isConnecting }) => (
              <button
                type="button"
                onClick={() => show?.()}
                disabled={Boolean(isConnecting)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
              >
                {isConnecting ? <Loader2 size={14} className="animate-spin" /> : <PlusCircle size={14} />}
                {isConnecting ? "Connecting..." : "Connect"}
              </button>
            )}
          </ConnectKitButton.Custom>
        )}
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Question (hashed on-chain)</label>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
          placeholder="Fed decision in March?"
        />
      </div>

      {status ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-cm-yes/40 bg-cm-yes-light px-3 py-2 text-xs text-cm-yes">
          <CheckCircle2 size={14} />
          <span>{status}</span>
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-cm-no/40 bg-cm-no-light px-3 py-2 text-xs text-cm-no">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
};

export default CreateMarketPanel;
