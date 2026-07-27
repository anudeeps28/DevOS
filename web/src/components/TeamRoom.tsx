import { AlertCircle, Bot, CheckCircle2, Gauge, Wrench } from 'lucide-react';

import type { SessionState, TranscriptEvent } from '@/lib/ws-client';
import { cn } from '@/lib/utils';

/** Cap on inline tool input / result content so a row never dominates the panel. */
const MAX_ROW_CHARS = 200;

/** Truncate long tool payloads for display; the full text stays in state. */
function truncate(text: string): string {
  return text.length > MAX_ROW_CHARS ? `${text.slice(0, MAX_ROW_CHARS)}…` : text;
}

/**
 * Pick the session the room shows: the most recent running session across all
 * projects (last-arrived wins, matching the hook's append-on-upsert ordering).
 */
function selectLiveSession(
  sessions: Record<string, readonly SessionState[]>,
): SessionState | null {
  let selected: SessionState | null = null;
  for (const sessionList of Object.values(sessions)) {
    for (const session of sessionList) {
      if (session.status === 'running') selected = session;
    }
  }
  return selected;
}

/** One transcript row, rendered per event kind. Render-only. */
function TranscriptRow({ event }: { event: TranscriptEvent }): JSX.Element | null {
  if (event.kind === 'init') {
    return (
      <li
        data-testid={`transcript-row-${event.seq}`}
        data-kind="init"
        className="flex items-center gap-2 text-xs text-muted-foreground/60"
      >
        <Bot aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="italic">session started</span>
      </li>
    );
  }

  if (event.kind === 'assistant-text') {
    return (
      <li
        data-testid={`transcript-row-${event.seq}`}
        data-kind="assistant-text"
        className="flex items-start gap-2 text-sm text-foreground"
      >
        <Bot aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 whitespace-pre-wrap break-words">{event.text}</span>
      </li>
    );
  }

  if (event.kind === 'tool-use') {
    return (
      <li
        data-testid={`transcript-row-${event.seq}`}
        data-kind="tool-use"
        className="flex items-start gap-2 text-xs text-muted-foreground"
      >
        <Wrench aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">
          <span className="font-medium text-foreground">{event.toolName}</span>{' '}
          <span className="break-all font-mono">{truncate(event.toolInput)}</span>
        </span>
      </li>
    );
  }

  if (event.kind === 'tool-result') {
    return (
      <li
        data-testid={`transcript-row-${event.seq}`}
        data-kind="tool-result"
        data-error={String(event.isError)}
        className={cn(
          'flex items-start gap-2 text-xs',
          event.isError ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {event.isError ? (
          <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <CheckCircle2 aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 break-all font-mono">{truncate(event.content)}</span>
      </li>
    );
  }

  if (event.kind === 'result') {
    return (
      <li
        data-testid={`transcript-row-${event.seq}`}
        data-kind="result"
        data-error={String(event.isError)}
        className={cn(
          'flex items-start gap-2 rounded-md border border-border px-2 py-1.5 text-xs',
          event.isError ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        <Gauge aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
          <span>in {event.inputTokens}</span>
          <span>out {event.outputTokens}</span>
          <span>{event.durationMs}ms</span>
          <span>{event.numTurns} turns</span>
          <span>${event.totalCostUsd.toFixed(4)}</span>
          {event.isError && <span className="font-medium">error</span>}
        </span>
      </li>
    );
  }

  return null; // future kinds render nothing rather than crash
}

/**
 * Team room — a live window into the selected (most recent running) owned
 * session's transcript. Render-only: state lives in useProjects; the parent
 * feeds `sessions` + `transcripts` as props. Empty state when no live session.
 */
export function TeamRoom({
  sessions,
  transcripts,
}: {
  sessions: Record<string, readonly SessionState[]>;
  transcripts: Record<string, readonly TranscriptEvent[]>;
}): JSX.Element {
  const live = selectLiveSession(sessions);

  return (
    <section
      data-testid="team-room"
      className={cn('flex w-full max-w-md flex-col gap-2')}
    >
      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Team room
      </span>
      {live === null ? (
        <p
          data-testid="team-room-empty"
          className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
        >
          No live session — spawn one from a pinned project.
        </p>
      ) : (
        <div
          data-testid={`team-room-session-${live.id}`}
          data-session-id={live.id}
          className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-sm">{live.projectPath}</span>
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              {live.role}
            </span>
          </div>
          <ul data-testid="team-room-transcript" className="flex flex-col gap-1.5">
            {(transcripts[live.id] ?? []).map((event) => (
              <TranscriptRow key={event.seq} event={event} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
