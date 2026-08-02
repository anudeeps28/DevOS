import { useEffect, useState } from 'react';
import { AlertCircle, Bot, CheckCircle2, Gauge, MessageSquare, Wrench } from 'lucide-react';

import type {
  PermissionRequest,
  SessionState,
  TranscriptEvent,
  WorkItemSessionAnchor,
} from '@/lib/ws-client';
import { cn } from '@/lib/utils';

/** Cap on inline tool input / result content so a row never dominates the panel. */
const MAX_ROW_CHARS = 200;

/** Truncate long tool payloads for display; the full text stays in state. */
function truncate(text: string): string {
  return text.length > MAX_ROW_CHARS ? `${text.slice(0, MAX_ROW_CHARS)}…` : text;
}

/** One allow/deny permission card for a pending request on the live session. */
function PermissionCard({
  request,
  onDecide,
}: {
  request: PermissionRequest;
  onDecide: (decision: 'allow' | 'deny' | 'allow-always') => void;
}): JSX.Element {
  return (
    <div
      data-testid={`permission-card-${request.requestId}`}
      className="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2"
    >
      <span className="text-sm font-medium text-foreground">
        {request.title ?? request.toolName}
      </span>
      <span className="break-all font-mono text-xs text-muted-foreground">
        {truncate(request.input)}
      </span>
      <div className="flex items-center gap-2">
        <button
          data-testid={`permission-allow-${request.requestId}`}
          type="button"
          onClick={() => onDecide('allow')}
          className="rounded-md border border-border bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
        >
          Allow
        </button>
        <button
          data-testid={`permission-deny-${request.requestId}`}
          type="button"
          onClick={() => onDecide('deny')}
          className="rounded-md border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Deny
        </button>
        <button
          data-testid={`permission-always-${request.requestId}`}
          type="button"
          onClick={() => onDecide('allow-always')}
          className="rounded-md border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Always allow
        </button>
      </div>
    </div>
  );
}

/**
 * Pick the session the room shows. With no `boundWorkItemId`, this is the most
 * recent running session across all projects (last-arrived wins, matching the
 * hook's append-on-upsert ordering) — the original, project-scoped behavior.
 * With a `boundWorkItemId`, the room is work-item-scoped: only the most recent
 * running session whose `workItemId` matches is eligible.
 */
export function selectLiveSession(
  sessions: Record<string, readonly SessionState[]>,
  boundWorkItemId?: string | null,
): SessionState | null {
  let selected: SessionState | null = null;
  for (const sessionList of Object.values(sessions)) {
    for (const session of sessionList) {
      if (session.status !== 'running') continue;
      if (boundWorkItemId != null && session.workItemId !== boundWorkItemId) continue;
      selected = session;
    }
  }
  return selected;
}

/**
 * Map every known work item to the projectPath of a session that has surfaced
 * it. Used to remember a work item's owning project even after its live
 * session ends, so a recycled-reopen request can still be issued for it.
 */
function collectWorkItemProjectPaths(
  sessions: Record<string, readonly SessionState[]>,
): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const sessionList of Object.values(sessions)) {
    for (const session of sessionList) {
      if (session.workItemId !== null) paths[session.workItemId] = session.projectPath;
    }
  }
  return paths;
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

  if (event.kind === 'user-text') {
    return (
      <li
        data-testid={`transcript-row-${event.seq}`}
        data-kind="user-text"
        className="flex items-start gap-2 text-sm font-medium text-foreground"
      >
        <MessageSquare aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
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
 * Team room — a live window into the selected owned session's transcript.
 * Render-only for `sessions` + `transcripts` (state lives in useProjects), but
 * owns one piece of local state itself: which work item the user has stickily
 * selected. That selection is independent of whether the item currently has a
 * running session — it stays bound to a recycled/reopened work item so the
 * "recycled — N sessions served this item" continuity line is reachable
 * through real user interaction, not just directly-injected props. With no
 * selection, the room falls back to the most-recent-running-session default.
 */
export function TeamRoom({
  sessions,
  transcripts,
  sendSessionInput,
  interruptSession,
  pendingPermissions = {},
  resolvePermission = () => {},
  workItemSessions = {},
  requestWorkItemSessions,
  connected,
}: {
  sessions: Record<string, readonly SessionState[]>;
  transcripts: Record<string, readonly TranscriptEvent[]>;
  sendSessionInput: (sessionId: string, text: string) => void;
  interruptSession: (sessionId: string) => void;
  pendingPermissions?: Record<string, readonly PermissionRequest[]>;
  resolvePermission?: (
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'allow-always',
  ) => void;
  workItemSessions?: Record<string, readonly WorkItemSessionAnchor[]>;
  requestWorkItemSessions?: (path: string, workItemId: string) => void;
  connected?: boolean;
}): JSX.Element {
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [knownWorkItemPaths, setKnownWorkItemPaths] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');

  // Remember every work item's owning projectPath as sessions surface it, so
  // the path is still known once its live session ends (recycled-reopen).
  useEffect(() => {
    const observed = collectWorkItemProjectPaths(sessions);
    setKnownWorkItemPaths((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [workItemId, path] of Object.entries(observed)) {
        if (next[workItemId] !== path) {
          next[workItemId] = path;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const boundWorkItemId = selectedWorkItemId ?? selectLiveSession(sessions)?.workItemId ?? null;
  const boundProjectPath =
    selectLiveSession(sessions, boundWorkItemId)?.projectPath ??
    (boundWorkItemId !== null ? knownWorkItemPaths[boundWorkItemId] : undefined) ??
    null;

  // (Re)request the bound work item's owned-session anchors whenever the
  // binding changes or the socket (re)connects — including when it currently
  // has no running session, which is exactly the recycled-reopen request.
  useEffect(() => {
    if (requestWorkItemSessions === undefined) return;
    if (boundWorkItemId === null || boundProjectPath === null) return;
    if (connected === false) return;
    requestWorkItemSessions(boundProjectPath, boundWorkItemId);
  }, [boundWorkItemId, boundProjectPath, connected, requestWorkItemSessions]);

  const knownWorkItemIds = Array.from(
    new Set([...Object.keys(knownWorkItemPaths), ...Object.keys(workItemSessions)]),
  ).sort();

  const live = selectLiveSession(sessions, boundWorkItemId);
  const boundWorkItemSessions = boundWorkItemId !== null ? workItemSessions[boundWorkItemId] ?? [] : [];

  // Steer the live session with the trimmed draft, then clear the field. Guarded so
  // an empty draft or a vanished session is a no-op.
  const handleSend = (): void => {
    const text = draft.trim();
    if (text.length === 0 || live === null) return;
    sendSessionInput(live.id, text);
    setDraft('');
  };

  return (
    <section
      data-testid="team-room"
      className={cn('flex w-full max-w-md flex-col gap-2')}
    >
      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Team room
      </span>
      {knownWorkItemIds.length > 0 && (
        <div data-testid="team-room-work-items" className="flex flex-wrap gap-1.5">
          {knownWorkItemIds.map((workItemId) => (
            <button
              key={workItemId}
              type="button"
              data-testid={`team-room-work-item-${workItemId}`}
              onClick={() => setSelectedWorkItemId(workItemId)}
              aria-pressed={boundWorkItemId === workItemId}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest',
                boundWorkItemId === workItemId
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {workItemId}
            </button>
          ))}
        </div>
      )}
      {live === null ? (
        boundWorkItemId !== null && boundWorkItemSessions.length > 0 ? (
          <p
            data-testid="team-room-recycled"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
          >
            recycled — {boundWorkItemSessions.length} sessions served this item
          </p>
        ) : (
          <p
            data-testid="team-room-empty"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
          >
            No live session — spawn one from a pinned project.
          </p>
        )
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
          {(pendingPermissions[live.id] ?? []).length > 0 && (
            <div data-testid="team-room-permissions" className="flex flex-col gap-2">
              {(pendingPermissions[live.id] ?? []).map((request) => (
                <PermissionCard
                  key={request.requestId}
                  request={request}
                  onDecide={(decision) => resolvePermission(live.id, request.requestId, decision)}
                />
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2 border-t border-border pt-2">
            <textarea
              data-testid="team-room-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message the agent…"
              rows={2}
              className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex items-center gap-2">
              <button
                data-testid="team-room-send"
                type="button"
                onClick={handleSend}
                disabled={draft.trim().length === 0}
                className="rounded-md border border-border bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
              <button
                data-testid="team-room-interrupt"
                type="button"
                onClick={() => interruptSession(live.id)}
                className="rounded-md border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Interrupt
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
