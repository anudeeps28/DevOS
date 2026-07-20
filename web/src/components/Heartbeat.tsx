import type { Heartbeat as HeartbeatData } from '@/lib/ws-client';

export interface HeartbeatProps {
  readonly heartbeat: HeartbeatData | null;
}

/** Format an epoch-ms timestamp as HH:MM:SS.mmm (24h, local time). */
function formatTs(ts: number): string {
  const time = new Date(ts).toLocaleTimeString(undefined, { hour12: false });
  const millis = String(Math.trunc(ts) % 1000).padStart(3, '0');
  return `${time}.${millis}`;
}

/**
 * Renders the live heartbeat sequence + formatted timestamp. The seq element
 * carries `data-testid="heartbeat-seq"` so e2e can assert it advances.
 */
export function Heartbeat({ heartbeat }: HeartbeatProps) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Heartbeat
      </span>
      <span
        data-testid="heartbeat-seq"
        className="font-mono text-5xl font-bold tabular-nums"
      >
        {heartbeat === null ? '—' : heartbeat.seq}
      </span>
      <span className="font-mono text-xs text-muted-foreground">
        {heartbeat === null ? 'waiting for first beat…' : formatTs(heartbeat.ts)}
      </span>
    </div>
  );
}
