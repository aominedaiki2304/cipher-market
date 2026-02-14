import { useMemo, useState } from 'react';
import { Activity, FileCheck2, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

type HealthPayload = {
  ok: boolean;
  chainId?: number;
  service?: string;
};

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

type EvidencePanelProps = {
  embedded?: boolean;
  className?: string;
};

const EvidencePanel = ({ embedded = false, className }: EvidencePanelProps) => {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [receiptsCount, setReceiptsCount] = useState<number | null>(null);
  const [traceStatus, setTraceStatus] = useState<string>('Not exported');
  const [busy, setBusy] = useState(false);

  const healthLabel = useMemo(() => {
    if (!health) return 'Unchecked';
    return health.ok ? `OK • chain ${health.chainId ?? '-'}` : 'Unavailable';
  }, [health]);

  async function refresh() {
    setBusy(true);
    try {
      const healthRes = await fetch(`${API_BASE_URL}/health`);
      const healthData = await healthRes.json();
      setHealth(healthData);

      const receiptsRes = await fetch(`${API_BASE_URL}/api/demo/receipts`);
      const receiptsData = await receiptsRes.json();
      setReceiptsCount(Array.isArray(receiptsData?.receipts) ? receiptsData.receipts.length : 0);
    } catch (_error) {
      setHealth({ ok: false });
      setReceiptsCount(null);
    } finally {
      setBusy(false);
    }
  }

  async function exportTrace() {
    setBusy(true);
    try {
      const result = await fetch(`${API_BASE_URL}/api/export-trace`, {
        method: 'POST'
      });
      const payload = await result.json();
      setTraceStatus(payload?.status === 'ok' ? 'Exported' : 'Export attempted');
    } catch (_error) {
      setTraceStatus('Export failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={cn(
        'rounded-lg border border-border bg-card p-3',
        embedded ? 'rounded-none border-0 bg-transparent p-0' : '',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-card-foreground">System Evidence</h2>
          <p className="text-xs text-muted-foreground">API health, receipts availability, and trace index status.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
          >
            {busy ? 'Working...' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={exportTrace}
            disabled={busy}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
          >
            Export Trace
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck size={13} />
            API Health
          </div>
          <p className="mt-1 text-sm font-semibold text-foreground">{healthLabel}</p>
        </div>
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileCheck2 size={13} />
            Demo Receipts
          </div>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {receiptsCount === null ? 'Unknown' : `${receiptsCount} loaded`}
          </p>
        </div>
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Activity size={13} />
            Trace Index
          </div>
          <p className="mt-1 text-sm font-semibold text-foreground">{traceStatus}</p>
        </div>
      </div>
    </section>
  );
};

export default EvidencePanel;
