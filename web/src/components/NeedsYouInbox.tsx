import { useState } from 'react';

import { AlertCircle, HelpCircle, MessageSquareWarning, Radio, ShieldQuestion } from 'lucide-react';

import type { BridgeInboxItem, BridgeState, ForeignNeedsYou, PermissionRequest } from '@/lib/ws-client';
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

/**
 * Needs-you inbox — a render-only list of parked bridge-inbox items (interrupts,
 * questions, escalations) waiting on human input, plus an Approve action per
 * item. State lives upstream; this component only renders the latest
 * BridgeState's inbox and reports clicks via `onApprove`.
 */
export function NeedsYouInbox({
  bridgeStates,
  onApprove,
  onRequestChanges = () => {},
  onAnswerQuestion = () => {},
  onEscalationChoice = () => {},
  permissions = [],
  onPermissionDecision = () => {},
  foreignItems = [],
}: {
  bridgeStates: readonly BridgeState[];
  onApprove: (path: string) => void;
  onRequestChanges?: (path: string, notes: string) => void;
  onAnswerQuestion?: (path: string, answer: string) => void;
  onEscalationChoice?: (
    path: string,
    choice: 'let-debug-try' | 'give-guidance' | 'take-over',
    notes?: string,
  ) => void;
  permissions?: readonly PermissionRequest[];
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'allow-always',
  ) => void;
  foreignItems?: readonly ForeignNeedsYou[];
}): JSX.Element {
  const inboxItems = bridgeStates.flatMap((state) =>
    state.inbox.map((item) => ({ item, path: state.path, gate: state.gate })),
  );
  // Keyed by a stable per-item identity (path + stage + ts), NOT array index — the
  // inbox is reordered by wait time upstream, so index-keyed notes would rebind to the
  // wrong item when the list shifts.
  const [notesByKey, setNotesByKey] = useState<Record<string, string>>({});

  return (
    <section
      data-testid="needs-you-inbox"
      className={cn('flex w-full max-w-md flex-col gap-2')}
    >
      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Needs you
      </span>
      {inboxItems.length === 0 && permissions.length === 0 && foreignItems.length === 0 ? (
        <p
          data-testid="needs-you-inbox-empty"
          className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
        >
          Nothing needs you right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {permissions.map((request) => (
            <li
              key={request.requestId}
              data-testid={`needs-you-permission-${request.requestId}`}
              className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex min-w-0 items-start gap-2">
                <ShieldQuestion aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    permission
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
          ))}
          {inboxItems.map((entry, index) => {
            const noteKey = `${entry.path}::${entry.item.stage}::${entry.item.ts}`;
            return (
            <li
              key={noteKey}
              data-testid={`needs-you-item-${index}`}
              data-kind={entry.item.kind}
              className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex min-w-0 items-start gap-2">
                <InboxIcon kind={entry.item.kind} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    {entry.item.stage}
                  </span>
                  <span className="text-sm text-foreground">{entry.item.reason}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {entry.item.kind === 'question' && entry.item.chips !== undefined ? (
                  <>
                    {entry.item.chips.map((chip, chipIndex) => (
                      <button
                        key={`${chip}-${chipIndex}`}
                        type="button"
                        data-testid={`needs-you-chip-${index}-${chipIndex}`}
                        onClick={() => onAnswerQuestion(entry.path, chip)}
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
                      onClick={() => onAnswerQuestion(entry.path, notesByKey[noteKey] ?? '')}
                      className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                    >
                      Send answer
                    </button>
                  </>
                ) : entry.item.kind === 'escalation' && entry.gate === 'escalated' ? (
                  <>
                    <button
                      type="button"
                      data-testid={`needs-you-escalation-debug-${index}`}
                      onClick={() => onEscalationChoice(entry.path, 'let-debug-try')}
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
                        onEscalationChoice(entry.path, 'give-guidance', notesByKey[noteKey] ?? '')
                      }
                      className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                    >
                      Give guidance
                    </button>
                    <button
                      type="button"
                      data-testid={`needs-you-escalation-takeover-${index}`}
                      onClick={() => onEscalationChoice(entry.path, 'take-over')}
                      className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                    >
                      Take over
                    </button>
                  </>
                ) : (
                  <>
                    {entry.item.kind === 'question' && (
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
                          onClick={() => onRequestChanges(entry.path, notesByKey[noteKey] ?? '')}
                          className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                        >
                          Request changes
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      data-testid={`needs-you-approve-${index}`}
                      onClick={() => onApprove(entry.path)}
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
          {foreignItems.map((item) => (
            <li
              key={item.sessionId}
              data-testid={`needs-you-foreign-${item.sessionId}`}
              data-kind={item.kind}
              className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex min-w-0 items-start gap-2">
                <Radio aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    foreign session
                  </span>
                  <span className="text-sm text-foreground">{item.reason || item.kind}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
