import { useEffect, useRef } from 'react';

import type { NeedsYouItem } from '@/lib/needs-you';

function isNotificationSupported(): boolean {
  return typeof Notification !== 'undefined' && 'Notification' in window;
}

/** Last path segment only — keeps the full local filesystem path out of the OS toast body. */
function projectLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return base || trimmed;
}

/** Derive a short human-readable label for a "needs you" item's toast body. */
function labelFor(item: NeedsYouItem): string {
  switch (item.source) {
    case 'permission':
      return `${item.request.toolName} needs permission — ${projectLabel(item.request.path)}`;
    case 'bridge':
      return `${item.item.kind} at ${item.item.stage} — ${projectLabel(item.path)}`;
    case 'foreign':
      return `${item.item.kind} — ${projectLabel(item.item.path)}`;
    default:
      return 'Needs your attention';
  }
}

/**
 * Fires a browser Notification for every newly-appeared "needs you" item.
 * No-ops entirely in environments without Notification support. Requests
 * permission once on mount when it's in the default (unasked) state. Never
 * toasts the initial backlog present on the first populated render — only
 * items that appear on subsequent renders.
 */
export function useNeedsYouToast(items: readonly NeedsYouItem[]): void {
  const seenKeysRef = useRef<Set<string> | null>(null);
  const requestedPermissionRef = useRef(false);

  useEffect(() => {
    if (!isNotificationSupported()) return;
    if (requestedPermissionRef.current) return;
    requestedPermissionRef.current = true;
    if (Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    const currentKeys = new Set(items.map((item) => item.key));
    const previousKeys = seenKeysRef.current;

    if (previousKeys !== null && isNotificationSupported() && Notification.permission === 'granted') {
      for (const item of items) {
        if (previousKeys.has(item.key)) continue;
        try {
          new Notification('Needs you', { body: labelFor(item) });
        } catch {
          // Never let a throwing environment break the app.
        }
      }
    }

    seenKeysRef.current = currentKeys;
  }, [items]);
}
