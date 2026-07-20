import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useProjects } from '@/hooks/useProjects';
import type {
  CandidateListener,
  ConnectionStatus,
  RegistryCandidate,
  RegistryListener,
  RegistryProject,
  StatusListener,
  WsClient,
} from '@/lib/ws-client';

/**
 * A fake WsClient that lets the test drive registry/candidate emissions and
 * asserts that pin/unpin/discover delegate through. Mirrors the injection
 * pattern in useHeartbeat.test.
 */
function makeFakeClient() {
  let registryListener: RegistryListener | null = null;
  let candidateListener: CandidateListener | null = null;
  let statusListener: StatusListener | null = null;
  const pin = vi.fn();
  const unpin = vi.fn();
  const discover = vi.fn();
  const close = vi.fn();

  const client: WsClient = {
    getStatus: () => 'connecting',
    onStatus: (listener) => {
      statusListener = listener;
      listener('connecting'); // mirror the real client's immediate sync
      return () => {
        statusListener = null;
      };
    },
    onHeartbeat: () => () => {},
    onRegistry: (listener) => {
      registryListener = listener;
      return () => {
        registryListener = null;
      };
    },
    onCandidates: (listener) => {
      candidateListener = listener;
      return () => {
        candidateListener = null;
      };
    },
    pin,
    unpin,
    discover,
    close,
  };

  return {
    client,
    pin,
    unpin,
    discover,
    close,
    emitRegistry: (projects: readonly RegistryProject[]) =>
      registryListener?.(projects),
    emitCandidates: (candidates: readonly RegistryCandidate[]) =>
      candidateListener?.(candidates),
    emitStatus: (status: ConnectionStatus) => statusListener?.(status),
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

function sampleCandidate(path: string): RegistryCandidate {
  return { path, displayName: null, hasClaudeInstall: true };
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

  it('starts with an empty candidates list', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    expect(result.current.candidates).toEqual([]);
  });

  it('surfaces candidates when a candidates frame is delivered', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    const candidates = [sampleCandidate('/abs/one'), sampleCandidate('/abs/two')];
    act(() => fake.emitCandidates(candidates));

    expect(result.current.candidates).toEqual(candidates);
  });

  it('delegates discover to the underlying client', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );
    // Ignore the auto-discover fired during the immediate 'connecting' sync.
    fake.discover.mockClear();

    act(() => result.current.discover());

    expect(fake.discover).toHaveBeenCalledTimes(1);
  });

  it('auto-discovers when the client reports connected', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    expect(fake.discover).not.toHaveBeenCalled();

    act(() => fake.emitStatus('connected'));

    expect(fake.discover).toHaveBeenCalledTimes(1);
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
