import { AlertCircle, HelpCircle, MessageSquareWarning, ShieldQuestion } from 'lucide-react';

import type { BridgeInboxItem, BridgeState, PermissionRequest } from '@/lib/ws-client';
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
  bridgeState,
  onApprove,
  permissions = [],
  onPermissionDecision = () => {},
}: {
  bridgeState: BridgeState | null;
  onApprove: (path: string) => void;
  permissions?: readonly PermissionRequest[];
  onPermissionDecision?: (sessionId: string, requestId: string, decision: 'allow' | 'deny') => void;
}): JSX.Element {
  const inbox = bridgeState?.inbox ?? [];

  return (
    <section
      data-testid="needs-you-inbox"
      className={cn('flex w-full max-w-md flex-col gap-2')}
    >
      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Needs you
      </span>
      {inbox.length === 0 && permissions.length === 0 ? (
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
              </div>
            </li>
          ))}
          {inbox.map((item, index) => (
            <li
              key={`${item.stage}-${item.ts}-${index}`}
              data-testid={`needs-you-item-${index}`}
              data-kind={item.kind}
              className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex min-w-0 items-start gap-2">
                <InboxIcon kind={item.kind} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    {item.stage}
                  </span>
                  <span className="text-sm text-foreground">{item.reason}</span>
                </div>
              </div>
              <button
                type="button"
                data-testid={`needs-you-approve-${index}`}
                onClick={() => bridgeState !== null && onApprove(bridgeState.path)}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
              >
                Approve
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
