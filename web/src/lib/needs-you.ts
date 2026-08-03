// Pure client-side derivation of the "needs you" inbox — no React, no I/O.
// Merges pending permission requests, bridge inbox items, and foreign-session
// needs-you signals into a single, deterministically ordered list. Everything
// here is a pure function over its inputs; nothing is mutated.

import type {
  BridgeInboxItem,
  BridgeState,
  ForeignNeedsYou,
  PermissionRequest,
} from '@/lib/ws-client';

/** One item in the merged "needs you" inbox, discriminated on `source`. */
export type NeedsYouItem =
  | {
      readonly source: 'permission';
      readonly waitSince: number;
      readonly key: string;
      readonly request: PermissionRequest;
    }
  | {
      readonly source: 'bridge';
      readonly waitSince: number;
      readonly key: string;
      readonly path: string;
      readonly gate: BridgeState['gate'];
      readonly item: BridgeInboxItem;
    }
  | {
      readonly source: 'foreign';
      readonly waitSince: number;
      readonly key: string;
      readonly item: ForeignNeedsYou;
    };

/**
 * Derive the merged "needs you" inbox from the raw useProjects() slices:
 * flatten pending permissions, bridge inbox entries, and foreign-session
 * needs-you signals into a single list, then sort ascending by `waitSince`
 * (longest wait first), tie-breaking by `key` for a deterministic order.
 * Pure + immutable — returns a new array.
 */
export function deriveNeedsYou(input: {
  readonly pendingPermissions: Record<string, readonly PermissionRequest[]>;
  readonly bridgeStates: Record<string, BridgeState>;
  readonly foreignNeedsYou: readonly ForeignNeedsYou[];
}): readonly NeedsYouItem[] {
  const items: NeedsYouItem[] = [];

  for (const request of Object.values(input.pendingPermissions).flat()) {
    items.push({
      source: 'permission',
      waitSince: request.ts,
      key: 'permission::' + request.requestId,
      request,
    });
  }

  for (const state of Object.values(input.bridgeStates)) {
    for (const inboxItem of state.inbox) {
      items.push({
        source: 'bridge',
        waitSince: inboxItem.ts,
        key: 'bridge::' + state.path + '::' + inboxItem.stage + '::' + inboxItem.ts,
        path: state.path,
        gate: state.gate,
        item: inboxItem,
      });
    }
  }

  for (const foreignItem of input.foreignNeedsYou) {
    if (foreignItem.cleared) continue;
    items.push({
      source: 'foreign',
      waitSince: foreignItem.ts,
      key: 'foreign::' + foreignItem.sessionId,
      item: foreignItem,
    });
  }

  return items.sort((a, b) => a.waitSince - b.waitSince || a.key.localeCompare(b.key));
}
