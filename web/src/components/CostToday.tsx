import type { CostUsage } from '@/lib/ws-client';

export interface CostTodayProps {
  readonly costToday: CostUsage | null;
}

/** Format a USD amount with two decimal places, e.g. `$12.34`. */
function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Renders the live cost/usage-today figure. The value element carries
 * `data-testid="cost-today"`. This is a usage indicator, not a bill.
 */
export function CostToday({ costToday }: CostTodayProps) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Usage today
      </span>
      <span data-testid="cost-today" className="font-mono text-2xl font-bold tabular-nums">
        {costToday === null ? '—' : formatUsd(costToday.costTodayUsd)}
      </span>
      {costToday !== null && (
        <span className="font-mono text-xs text-muted-foreground">
          {costToday.inputTokensToday.toLocaleString()} in /{' '}
          {costToday.outputTokensToday.toLocaleString()} out tokens
        </span>
      )}
    </div>
  );
}
