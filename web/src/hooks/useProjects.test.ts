import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useProjects } from '@/hooks/useProjects';
import type {
  RegistryListener,
  RegistryProject,
  WsClient,
} from '@/lib/ws-client';

/**
 * A fake WsClient that lets the test drive registry emissions and asserts that
 * pin/unpin delegate through. Mirrors the injection pattern in useHeartbeat.test.
 */
function makeFakeClient() {
  let registryListener: RegistryListener | null = null;
  const pin = vi.fn();
  const unpin = vi.fn();
  const close = vi.fn();

  const client: WsClient = {
    getStatus: () => 'connecting',
    onStatus: () => () => {},
    onHeartbeat: () => () => {},
    onRegistry: (listener) => {
      registryListener = listener;
      return () => {
        registryListener = null;
      };
    },
    pin,
    unpin,
    close,
  };

  return {
    client,
    pin,
    unpin,
    close,
    emitRegistry: (projects: readonly RegistryProject[]) =>
      registryListener?.(projects),
  };
}

function sampleProject(path: string): RegistryProject {
  return {
    path,
    displayName: null,
    pinned: true,
    uiPrefs: null,
    createdAt: 1700000000000,
  };
}

describe('useProjects', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with an empty projects list', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    expect(result.current.projects).toEqual([]);
  });

  it('updates projects when a registry frame is delivered', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    const projects = [sampleProject('/abs/one'), sampleProject('/abs/two')];
    act(() => fake.emitRegistry(projects));

    expect(result.current.projects).toEqual(projects);
  });

  it('delegates pin/unpin to the underlying client', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    act(() => result.current.pin('/abs/path', { displayName: 'X' }));
    expect(fake.pin).toHaveBeenCalledWith('/abs/path', { displayName: 'X' });

    act(() => result.current.unpin('/abs/path'));
    expect(fake.unpin).toHaveBeenCalledWith('/abs/path');
  });

  it('closes the client on unmount', () => {
    const fake = makeFakeClient();
    const { unmount } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    expect(fake.close).not.toHaveBeenCalled();
    unmount();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
