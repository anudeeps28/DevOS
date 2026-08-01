import type { DerivedState, FleetLane, SessionLane } from '@/lib/fleet-state';
import { cn } from '@/lib/utils';

/** Human-readable label for a derived state; rate-limit gets the exact wording the fleet tab requires. */
function derivedStateLabel(state: DerivedState): string {
  if (state === 'waiting-on-rate-limit') return 'waiting — plan limit';
  return state;
}

/** One session row: persona badge, human state label, and its nested subagent lane. */
function SessionRow({ session }: { session: SessionLane }): JSX.Element {
  return (
    <li
      data-testid="fleet-session"
      data-role={session.role}
      data-derived-state={session.derivedState}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-testid="fleet-persona"
            className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground"
          >
            {session.persona ?? session.role}
          </span>
          <span className="text-xs text-muted-foreground">{session.role}</span>
        </div>
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {derivedStateLabel(session.derivedState)}
        </span>
      </div>
      <div
        data-testid="fleet-subagents"
        className="flex flex-col gap-1 border-l border-dashed border-border pl-3"
      >
        {session.subagents.length === 0 ? (
          <span className="text-[10px] italic text-muted-foreground/60">no inner subagents</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {session.subagents.map((subagent) => (
              <li
                key={subagent.id}
                data-testid="fleet-subagent"
                className="truncate text-[10px] text-muted-foreground"
              >
                {subagent.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * Presentational fleet view: one lane per work item, each holding its
 * sessions, each session holding its own (always-present) subagent lane.
 * All state is derived upstream by `deriveFleet`; this component only renders.
 */
export function Fleet({ lanes }: { lanes: readonly FleetLane[] }): JSX.Element {
  if (lanes.length === 0) {
    return (
      <p
        data-testid="fleet-empty"
        className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
      >
        No active sessions.
      </p>
    );
  }

  return (
    <div className={cn('flex w-full max-w-md flex-col gap-3')}>
      {lanes.map((lane) => (
        <section
          key={lane.workItemId}
          data-testid="fleet-workitem"
          data-workitem={lane.workItemId}
          className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3"
        >
          <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {lane.workItemId}
          </span>
          <ul className="flex flex-col gap-2">
            {lane.sessions.map((session) => (
              <SessionRow key={session.sessionId} session={session} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
