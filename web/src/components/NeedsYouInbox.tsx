import { useState } from 'react';

import { AlertCircle, HelpCircle, MessageSquareWarning, Radio, ShieldQuestion } from 'lucide-react';

import type { NeedsYouItem } from '@/lib/needs-you';
import type { BridgeInboxItem } from '@/lib/ws-client';
import { cn } from '@/lib/utils';

/** Icon per parked-item kind. */
function InboxIcon({ kind }: { kind: BridgeInboxItem['kind'] }): JSX.Element {
  if (kind === 'interrupt') {
    return <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />;
  }
  if (kind === 'escalation') {
    return <MessageSquareWarning aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  return <HelpCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

/** Format a `waitSince` epoch-ms timestamp as a short relative duration, e.g. "3m" / "1h" / "2d". */
function formatWait(waitSince: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - waitSince) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Needs-you inbox — a render-only, pre-sorted list of everything blocked on
 * human input across every project (permission requests, parked bridge-inbox
 * items, and foreign-session signals). State lives upstream; `items` is
 * expected to already be merged and sorted (see `deriveNeedsYou`) and this
 * component only dispatches per-item markup and reports clicks via callbacks.
 */
export function NeedsYouInbox({
  items,
  onApprove,
  onRequestChanges = () => {},
  onAnswerQuestion = () => {},
  onEscalationChoice = () => {},
  onPermissionDecision = () => {},
}: {
  items: readonly NeedsYouItem[];
  onApprove: (path: string) => void;
  onRequestChanges?: (path: string, notes: string) => void;
  onAnswerQuestion?: (path: string, answer: string) => void;
  onEscalationChoice?: (
    path: string,
    choice: 'let-debug-try' | 'give-guidance' | 'take-over',
    notes?: string,
  ) => void;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'allow-always',
  ) => void;
}): JSX.Element {
  // Keyed by each item's stable `key`, NOT array index — the list is reordered
  // by wait time upstream, so index-keyed notes would rebind to the wrong item
  // when the list shifts.
  const [notesByKey, setNotesByKey] = useState<Record<string, string>>({});

  return (
    <section
      data-testid="needs-you-inbox"
      className={cn('flex w-full max-w-md flex-col gap-2')}
    >
      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Needs you
      </span>
      {items.length === 0 ? (
        <p
          data-testid="needs-you-inbox-empty"
          className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
        >
          Nothing needs you right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((entry, index) => {
            if (entry.source === 'permission') {
              const request = entry.request;
              return (
                <li
                  key={entry.key}
                  data-testid={`needs-you-permission-${request.requestId}`}
                  className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card p-3"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <ShieldQuestion aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                        permission &middot; {formatWait(entry.waitSince)}
                      </span>
                      <span className="text-sm text-foreground">
                        {request.title ?? request.toolName}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      data-testid={`needs-you-permission-allow-${request.requestId}`}
                      onClick={() => onPermissionDecision(request.sessionId, request.requestId, 'allow')}
                      className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      data-testid={`needs-you-permission-deny-${request.requestId}`}
                      onClick={() => onPermissionDecision(request.sessionId, request.requestId, 'deny')}
                      className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      data-testid={`needs-you-permission-always-${request.requestId}`}
                      onClick={() => onPermissionDecision(request.sessionId, request.requestId, 'allow-always')}
                      className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                    >
                      Always allow
                    </button>
                  </div>
                </li>
              );
            }

            if (entry.source === 'foreign') {
              const foreignItem = entry.item;
              return (
                <li
                  key={entry.key}
                  data-testid={`needs-you-foreign-${foreignItem.sessionId}`}
                  data-kind={foreignItem.kind}
                  className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card p-3"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <Radio aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                        foreign session &middot; {formatWait(entry.waitSince)}
                      </span>
                      <span className="text-sm text-foreground">{foreignItem.reason || foreignItem.kind}</span>
                    </div>
                  </div>
                </li>
              );
            }

            const { path, gate, item: bridgeItem } = entry;
            const noteKey = entry.key;
            return (
              <li
                key={entry.key}
                data-testid={`needs-you-item-${index}`}
                data-kind={bridgeItem.kind}
                className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card p-3"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <InboxIcon kind={bridgeItem.kind} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                      {bridgeItem.stage} &middot; {formatWait(entry.waitSince)}
                    </span>
                    <span className="text-sm text-foreground">{bridgeItem.reason}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {bridgeItem.kind === 'question' && bridgeItem.chips !== undefined ? (
                    <>
                      {bridgeItem.chips.map((chip, chipIndex) => (
                        <button
                          key={`${chip}-${chipIndex}`}
                          type="button"
                          data-testid={`needs-you-chip-${index}-${chipIndex}`}
                          onClick={() => onAnswerQuestion(path, chip)}
                          className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                        >
                          {chip}
                        </button>
                      ))}
                      <input
                        type="text"
                        data-testid={`needs-you-notes-${index}`}
                        value={notesByKey[noteKey] ?? ''}
                        onChange={(event) =>
                          setNotesByKey((prev) => ({ ...prev, [noteKey]: event.target.value }))
                        }
                        className="rounded-md border border-border px-2 py-1 text-xs text-foreground"
                      />
                      <button
                        type="button"
                        data-testid={`needs-you-answer-${index}`}
                        onClick={() => onAnswerQuestion(path, notesByKey[noteKey] ?? '')}
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                      >
                        Send answer
                      </button>
                    </>
                  ) : bridgeItem.kind === 'escalation' && gate === 'escalated' ? (
                    <>
                      <button
                        type="button"
                        data-testid={`needs-you-escalation-debug-${index}`}
                        onClick={() => onEscalationChoice(path, 'let-debug-try')}
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                      >
                        Let debug try
                      </button>
                      <input
                        type="text"
                        data-testid={`needs-you-notes-${index}`}
                        value={notesByKey[noteKey] ?? ''}
                        onChange={(event) =>
                          setNotesByKey((prev) => ({ ...prev, [noteKey]: event.target.value }))
                        }
                        className="rounded-md border border-border px-2 py-1 text-xs text-foreground"
                      />
                      <button
                        type="button"
                        data-testid={`needs-you-escalation-guidance-${index}`}
                        onClick={() =>
                          onEscalationChoice(path, 'give-guidance', notesByKey[noteKey] ?? '')
                        }
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                      >
                        Give guidance
                      </button>
                      <button
                        type="button"
                        data-testid={`needs-you-escalation-takeover-${index}`}
                        onClick={() => onEscalationChoice(path, 'take-over')}
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                      >
                        Take over
                      </button>
                    </>
                  ) : (
                    <>
                      {bridgeItem.kind === 'question' && (
                        <>
                          <input
                            type="text"
                            data-testid={`needs-you-notes-${index}`}
                            value={notesByKey[noteKey] ?? ''}
                            onChange={(event) =>
                              setNotesByKey((prev) => ({ ...prev, [noteKey]: event.target.value }))
                            }
                            className="rounded-md border border-border px-2 py-1 text-xs text-foreground"
                          />
                          <button
                            type="button"
                            data-testid={`needs-you-request-changes-${index}`}
                            onClick={() => onRequestChanges(path, notesByKey[noteKey] ?? '')}
                            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                          >
                            Request changes
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        data-testid={`needs-you-approve-${index}`}
                        onClick={() => onApprove(path)}
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                      >
                        Approve
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
