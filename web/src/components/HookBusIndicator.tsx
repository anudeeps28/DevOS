import { cn } from '@/lib/utils';

export interface HookBusIndicatorProps {
  readonly connected: boolean;
}

/**
 * Presentational badge for the server's hook-bus liveness. Renders nothing
 * when connected; surfaces a red "Hook bus not connected" badge otherwise.
 * Exposes a stable e2e hook: `data-testid="hook-bus-status"` with
 * `data-connected` mirroring the boolean prop.
 */
export function HookBusIndicator({ connected }: HookBusIndicatorProps) {
  if (connected) return null;

  return (
    <div
      data-testid="hook-bus-status"
      data-connected="false"
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium',
        'border-red-500/40 text-red-700 dark:text-red-400',
      )}
    >
      <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
      Hook bus not connected
    </div>
  );
}
