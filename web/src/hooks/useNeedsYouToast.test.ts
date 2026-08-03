import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNeedsYouToast } from '@/hooks/useNeedsYouToast';
import type { NeedsYouItem } from '@/lib/needs-you';

function makePermissionItem(requestId: string, ts: number): NeedsYouItem {
  return {
    source: 'permission',
    waitSince: ts,
    key: 'permission::' + requestId,
    request: {
      path: '/repo',
      sessionId: 'session-1',
      requestId,
      toolUseId: null,
      toolName: 'Bash',
      title: null,
      input: '{}',
      ts,
    },
  };
}

describe('useNeedsYouToast', () => {
  let originalNotification: unknown;

  beforeEach(() => {
    originalNotification = (globalThis as { Notification?: unknown }).Notification;
  });

  afterEach(() => {
    (globalThis as { Notification?: unknown }).Notification = originalNotification;
    vi.restoreAllMocks();
  });

  function installNotificationSpy(permission: NotificationPermission) {
    const requestPermission = vi.fn().mockResolvedValue(permission);
    const constructorSpy = vi.fn();

    class FakeNotification {
      static permission = permission;
      static requestPermission = requestPermission;
      constructor(title: string, options?: NotificationOptions) {
        constructorSpy(title, options);
      }
    }

    (globalThis as { Notification?: unknown }).Notification = FakeNotification;

    return { requestPermission, constructorSpy };
  }

  it('does not throw and never constructs a Notification when unsupported', () => {
    delete (globalThis as { Notification?: unknown }).Notification;

    expect(() => {
      const { rerender } = renderHook(({ items }) => useNeedsYouToast(items), {
        initialProps: { items: [] as readonly NeedsYouItem[] },
      });
      rerender({ items: [makePermissionItem('a', 1)] });
    }).not.toThrow();
  });

  it('requests permission once when permission is default', () => {
    const { requestPermission } = installNotificationSpy('default');

    const { rerender } = renderHook(({ items }) => useNeedsYouToast(items), {
      initialProps: { items: [] as readonly NeedsYouItem[] },
    });
    rerender({ items: [] as readonly NeedsYouItem[] });

    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('constructs one Notification for a newly-appeared item when granted', () => {
    const { constructorSpy } = installNotificationSpy('granted');

    const { rerender } = renderHook(({ items }) => useNeedsYouToast(items), {
      initialProps: { items: [makePermissionItem('a', 1)] as readonly NeedsYouItem[] },
    });

    expect(constructorSpy).not.toHaveBeenCalled();

    rerender({ items: [makePermissionItem('a', 1), makePermissionItem('b', 2)] });

    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(constructorSpy).toHaveBeenCalledWith('Needs you', expect.anything());
  });

  it('does not construct a Notification for items already present on the previous render', () => {
    const { constructorSpy } = installNotificationSpy('granted');

    const { rerender } = renderHook(({ items }) => useNeedsYouToast(items), {
      initialProps: { items: [makePermissionItem('a', 1)] as readonly NeedsYouItem[] },
    });

    rerender({ items: [makePermissionItem('a', 1)] });

    expect(constructorSpy).not.toHaveBeenCalled();
  });

  it('does not toast the initial backlog', () => {
    const { constructorSpy } = installNotificationSpy('granted');

    renderHook(({ items }) => useNeedsYouToast(items), {
      initialProps: {
        items: [makePermissionItem('a', 1), makePermissionItem('b', 2)] as readonly NeedsYouItem[],
      },
    });

    expect(constructorSpy).not.toHaveBeenCalled();
  });
});
