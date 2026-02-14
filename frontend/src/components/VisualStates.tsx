import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

export const LoadingCards = () => (
  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex gap-3">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
        <Skeleton className="h-8 w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-8 flex-1 rounded-lg" />
          <Skeleton className="h-8 flex-1 rounded-lg" />
        </div>
        <div className="flex justify-between">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-12" />
        </div>
      </div>
    ))}
  </div>
);

export const EmptyState = ({ message = 'No markets found' }: { message?: string }) => (
  <div className="flex flex-col items-center justify-center py-20 text-center">
    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
      <span className="text-xl">📊</span>
    </div>
    <p className="text-sm text-muted-foreground">{message}</p>
  </div>
);

export const ErrorState = ({ onRetry }: { onRetry?: () => void }) => (
  <div className="mx-4 rounded-lg border border-cm-no/20 bg-cm-no-light p-4">
    <div className="flex items-center gap-3">
      <AlertTriangle size={18} className="text-cm-no shrink-0" />
      <p className="flex-1 text-sm text-foreground">Something went wrong loading markets.</p>
      <button
        onClick={onRetry}
        className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
      >
        <RefreshCw size={12} />
        Retry
      </button>
    </div>
  </div>
);
