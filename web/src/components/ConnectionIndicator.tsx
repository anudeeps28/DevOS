import { cn } from '@/lib/utils';
import type { ConnectionStatus } from '@/lib/ws-client';

const LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
};

const DOT_CLASSES: Record<ConnectionStatus, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-amber-500 animate-pulse',
  disconnected: 'bg-red-500',
};

const BADGE_CLASSES: Record<ConnectionStatus, string> = {
  connected: 'border-green-500/40 text-green-700 dark:text-green-400',
  connecting: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  disconnected: 'border-red-500/40 text-red-700 dark:text-red-400',
};

export interface ConnectionIndicatorProps {
  readonly status: ConnectionStatus;
}

/**
 * Accessible connection badge. Exposes a stable e2e hook:
 * `data-testid="connection-status"` with `data-status` mirroring the status.
 */
export function ConnectionIndicator({ status }: ConnectionIndicatorProps) {
  return (
    <div
      data-testid="connection-status"
      data-status={status}
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium',
        BADGE_CLASSES[status],
      )}
    >
      <span
        className={cn('h-2 w-2 rounded-full', DOT_CLASSES[status])}
        aria-hidden="true"
      />
      {LABELS[status]}
    </div>
  );
}
