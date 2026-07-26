import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useProjects } from '@/hooks/useProjects';
import type {
  CandidateListener,
  ConnectionStatus,
  GitState,
  GitStateListener,
  LifecycleSignals,
  LifecycleSignalsListener,
  RegistryCandidate,
  RegistryListener,
  RegistryProject,
  SessionState,
  SessionStateListener,
  StatusListener,
  TrackerState,
  TrackerStateListener,
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
  let gitStateListener: GitStateListener | null = null;
  let trackerStateListener: TrackerStateListener | null = null;
  let lifecycleSignalsListener: LifecycleSignalsListener | null = null;
  let sessionStateListener: SessionStateListener | null = null;
  const pin = vi.fn();
  const unpin = vi.fn();
  const discover = vi.fn();
  const requestGitState = vi.fn();
  const requestTrackerState = vi.fn();
  const requestLifecycleSignals = vi.fn();
  const spawnSession = vi.fn();
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
    onGitState: (listener) => {
      gitStateListener = listener;
      return () => {
        gitStateListener = null;
      };
    },
    onTrackerState: (listener) => {
      trackerStateListener = listener;
      return () => {
        trackerStateListener = null;
      };
    },
    onLifecycleSignals: (listener) => {
      lifecycleSignalsListener = listener;
      return () => {
        lifecycleSignalsListener = null;
      };
    },
    onSessionState: (listener) => {
      sessionStateListener = listener;
      return () => {
        sessionStateListener = null;
      };
    },
    pin,
    unpin,
    discover,
    requestGitState,
    requestTrackerState,
    requestLifecycleSignals,
    spawnSession,
    close,
  };

  return {
    client,
    pin,
    unpin,
    discover,
    requestGitState,
    requestTrackerState,
    requestLifecycleSignals,
    spawnSession,
    close,
    emitRegistry: (projects: readonly RegistryProject[]) =>
      registryListener?.(projects),
    emitCandidates: (candidates: readonly RegistryCandidate[]) =>
      candidateListener?.(candidates),
    emitStatus: (status: ConnectionStatus) => statusListener?.(status),
    emitGitState: (path: string, state: GitState) =>
      gitStateListener?.(path, state),
    emitTrackerState: (path: string, state: TrackerState) =>
      trackerStateListener?.(path, state),
    emitLifecycleSignals: (path: string, signals: LifecycleSignals) =>
      lifecycleSignalsListener?.(path, signals),
    emitSessionState: (path: string, session: SessionState) =>
      sessionStateListener?.(path, session),
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

function sampleGitState(path: string): GitState {
  return {
    path,
    isRepo: true,
    branch: 'main',
    detached: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    upstream: 'origin/main',
  };
}

function sampleTrackerState(path: string): TrackerState {
  return {
    path,
    reachable: true,
    tracker: 'todoist',
    nextTask: { id: '1', title: 'Do the thing', priority: 4, url: null },
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

  it('starts with an empty gitStates map', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    expect(result.current.gitStates).toEqual({});
  });

  it('folds an emitted git-state into gitStates keyed by path', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    const stateOne = sampleGitState('/abs/one');
    act(() => fake.emitGitState('/abs/one', stateOne));
    expect(result.current.gitStates).toEqual({ '/abs/one': stateOne });

    const stateTwo = sampleGitState('/abs/two');
    act(() => fake.emitGitState('/abs/two', stateTwo));
    expect(result.current.gitStates).toEqual({
      '/abs/one': stateOne,
      '/abs/two': stateTwo,
    });
  });

  it('delegates requestGitState to the underlying client', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    act(() => result.current.requestGitState('/abs/path'));

    expect(fake.requestGitState).toHaveBeenCalledWith('/abs/path');
  });

  it('folds session-state snapshots into sessions keyed by path, upserting by id', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    const running: SessionState = {
      id: 'sess-1',
      projectPath: '/abs/one',
      role: 'shipwright',
      status: 'running',
      sdkSessionId: null,
    };
    act(() => fake.emitSessionState('/abs/one', running));
    expect(result.current.sessions['/abs/one']).toEqual([running]);

    // A later snapshot for the SAME id replaces (upserts) — not appended.
    const ended: SessionState = { ...running, status: 'ended', sdkSessionId: 'sdk-1' };
    act(() => fake.emitSessionState('/abs/one', ended));
    expect(result.current.sessions['/abs/one']).toEqual([ended]);

    // A second distinct id is appended alongside.
    const second: SessionState = { ...running, id: 'sess-2' };
    act(() => fake.emitSessionState('/abs/one', second));
    expect(result.current.sessions['/abs/one']).toHaveLength(2);
  });

  it('delegates spawnSession to the underlying client', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    act(() => result.current.spawnSession('/abs/path', 'lookout'));

    expect(fake.spawnSession).toHaveBeenCalledWith('/abs/path', 'lookout');
  });

  it('requests git-state for each pinned project when the registry arrives', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    act(() =>
      fake.emitRegistry([sampleProject('/abs/one'), sampleProject('/abs/two')]),
    );

    expect(fake.requestGitState).toHaveBeenCalledWith('/abs/one');
    expect(fake.requestGitState).toHaveBeenCalledWith('/abs/two');
    expect(fake.requestGitState).toHaveBeenCalledTimes(2);
  });

  it('requests git-state for known projects on connect', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    act(() =>
      fake.emitRegistry([sampleProject('/abs/one'), sampleProject('/abs/two')]),
    );
    fake.requestGitState.mockClear();

    act(() => fake.emitStatus('connected'));

    expect(fake.requestGitState).toHaveBeenCalledWith('/abs/one');
    expect(fake.requestGitState).toHaveBeenCalledWith('/abs/two');
    expect(fake.requestGitState).toHaveBeenCalledTimes(2);
  });

  it('starts with an empty trackerStates map', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    expect(result.current.trackerStates).toEqual({});
  });

  it('folds an emitted tracker-state into trackerStates keyed by path', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    const stateOne = sampleTrackerState('/abs/one');
    act(() => fake.emitTrackerState('/abs/one', stateOne));
    expect(result.current.trackerStates).toEqual({ '/abs/one': stateOne });

    const stateTwo = sampleTrackerState('/abs/two');
    act(() => fake.emitTrackerState('/abs/two', stateTwo));
    expect(result.current.trackerStates).toEqual({
      '/abs/one': stateOne,
      '/abs/two': stateTwo,
    });
  });

  it('delegates requestTrackerState to the underlying client', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    act(() => result.current.requestTrackerState('/abs/path'));

    expect(fake.requestTrackerState).toHaveBeenCalledWith('/abs/path');
  });

  it('requests tracker-state for each pinned project when the registry arrives', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    act(() =>
      fake.emitRegistry([sampleProject('/abs/one'), sampleProject('/abs/two')]),
    );

    expect(fake.requestTrackerState).toHaveBeenCalledWith('/abs/one');
    expect(fake.requestTrackerState).toHaveBeenCalledWith('/abs/two');
    expect(fake.requestTrackerState).toHaveBeenCalledTimes(2);
  });

  it('requests tracker-state for known projects on connect', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    act(() =>
      fake.emitRegistry([sampleProject('/abs/one'), sampleProject('/abs/two')]),
    );
    fake.requestTrackerState.mockClear();

    act(() => fake.emitStatus('connected'));

    expect(fake.requestTrackerState).toHaveBeenCalledWith('/abs/one');
    expect(fake.requestTrackerState).toHaveBeenCalledWith('/abs/two');
    expect(fake.requestTrackerState).toHaveBeenCalledTimes(2);
  });

  it('starts with an empty lifecycleSignals map', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    expect(result.current.lifecycleSignals).toEqual({});
  });

  it('folds an emitted lifecycle-signals into lifecycleSignals keyed by path', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    const signalsOne: LifecycleSignals = {
      hasDecideDocs: false,
      hasDefineDocs: false,
      hasStartedStory: true,
      hasFeatureBranchCommits: false,
      hasReleaseTags: false,
    };
    act(() => fake.emitLifecycleSignals('/abs/one', signalsOne));
    expect(result.current.lifecycleSignals).toEqual({ '/abs/one': signalsOne });

    const signalsTwo: LifecycleSignals = {
      hasDecideDocs: false,
      hasDefineDocs: true,
      hasStartedStory: false,
      hasFeatureBranchCommits: false,
      hasReleaseTags: false,
    };
    act(() => fake.emitLifecycleSignals('/abs/two', signalsTwo));
    expect(result.current.lifecycleSignals).toEqual({
      '/abs/one': signalsOne,
      '/abs/two': signalsTwo,
    });
  });

  it('delegates requestLifecycleSignals to the underlying client', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    act(() => result.current.requestLifecycleSignals('/abs/path'));

    expect(fake.requestLifecycleSignals).toHaveBeenCalledWith('/abs/path');
  });

  it('requests lifecycle-signals for each pinned project when the registry arrives', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    act(() =>
      fake.emitRegistry([sampleProject('/abs/one'), sampleProject('/abs/two')]),
    );

    expect(fake.requestLifecycleSignals).toHaveBeenCalledWith('/abs/one');
    expect(fake.requestLifecycleSignals).toHaveBeenCalledWith('/abs/two');
    expect(fake.requestLifecycleSignals).toHaveBeenCalledTimes(2);
  });

  it('requests lifecycle-signals for known projects on connect', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    act(() =>
      fake.emitRegistry([sampleProject('/abs/one'), sampleProject('/abs/two')]),
    );
    fake.requestLifecycleSignals.mockClear();

    act(() => fake.emitStatus('connected'));

    expect(fake.requestLifecycleSignals).toHaveBeenCalledWith('/abs/one');
    expect(fake.requestLifecycleSignals).toHaveBeenCalledWith('/abs/two');
    expect(fake.requestLifecycleSignals).toHaveBeenCalledTimes(2);
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
