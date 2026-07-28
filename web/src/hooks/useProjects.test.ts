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
  SessionTranscriptListener,
  StatusListener,
  TrackerState,
  TrackerStateListener,
  TranscriptEvent,
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
  let sessionTranscriptListener: SessionTranscriptListener | null = null;
  const pin = vi.fn();
  const unpin = vi.fn();
  const discover = vi.fn();
  const requestGitState = vi.fn();
  const requestTrackerState = vi.fn();
  const requestLifecycleSignals = vi.fn();
  const spawnSession = vi.fn();
  const requestTranscript = vi.fn();
  const sendSessionInput = vi.fn();
  const interruptSession = vi.fn();
  const sendBridgeStart = vi.fn();
  const sendGateApprove = vi.fn();
  const sendBridgeInterrupt = vi.fn();
  const sendPermissionDecision = vi.fn();
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
    onSessionTranscript: (listener) => {
      sessionTranscriptListener = listener;
      return () => {
        sessionTranscriptListener = null;
      };
    },
    onBridgeState: () => () => {},
    onPermissionRequest: () => () => {},
    pin,
    unpin,
    discover,
    requestGitState,
    requestTrackerState,
    requestLifecycleSignals,
    spawnSession,
    requestTranscript,
    sendSessionInput,
    interruptSession,
    sendBridgeStart,
    sendGateApprove,
    sendBridgeInterrupt,
    sendPermissionDecision,
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
    requestTranscript,
    sendSessionInput,
    interruptSession,
    sendBridgeStart,
    sendGateApprove,
    sendBridgeInterrupt,
    sendPermissionDecision,
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
    emitSessionTranscript: (
      path: string,
      sessionId: string,
      events: readonly TranscriptEvent[],
    ) => sessionTranscriptListener?.(path, sessionId, events),
  };
}

/** Build a stamped assistant-text transcript event for fold fixtures. */
function transcriptEvent(seq: number, text = `event-${seq}`): TranscriptEvent {
  return {
    kind: 'assistant-text',
    text,
    sessionId: 'sess-1',
    seq,
    ts: 1700000000000 + seq,
  };
}

function runningSession(id: string, path = '/abs/one'): SessionState {
  return {
    id,
    projectPath: path,
    role: 'shipwright',
    status: 'running',
    sdkSessionId: null,
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

  it('starts with an empty transcripts map', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    expect(result.current.transcripts).toEqual({});
  });

  it('folds transcript batches by seq — dedupes, replaces, and sorts ascending', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    // Out-of-order first batch is sorted ascending.
    act(() =>
      fake.emitSessionTranscript('/abs/one', 'sess-1', [
        transcriptEvent(2),
        transcriptEvent(0),
        transcriptEvent(1),
      ]),
    );
    expect(result.current.transcripts['sess-1']!.map((e) => e.seq)).toEqual([0, 1, 2]);

    // A repeated seq replaces (upserts) the prior event, not appended.
    const replacement = transcriptEvent(1, 'replaced');
    act(() => fake.emitSessionTranscript('/abs/one', 'sess-1', [replacement, transcriptEvent(3)]));
    const folded = result.current.transcripts['sess-1']!;
    expect(folded.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(folded[1]).toEqual(replacement);
  });

  it('keeps transcripts isolated per session id', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    act(() => fake.emitSessionTranscript('/abs/one', 'sess-1', [transcriptEvent(0)]));
    act(() =>
      fake.emitSessionTranscript('/abs/two', 'sess-2', [
        { ...transcriptEvent(0), sessionId: 'sess-2' },
      ]),
    );

    expect(result.current.transcripts['sess-1']).toHaveLength(1);
    expect(result.current.transcripts['sess-2']).toHaveLength(1);
  });

  it('bounds the folded transcript to the last 500 events', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    const events = Array.from({ length: 510 }, (_, seq) => transcriptEvent(seq));
    act(() => fake.emitSessionTranscript('/abs/one', 'sess-1', events));

    const folded = result.current.transcripts['sess-1']!;
    expect(folded).toHaveLength(500);
    // Oldest dropped: the window starts at seq 10 and ends at 509.
    expect(folded[0]!.seq).toBe(10);
    expect(folded[folded.length - 1]!.seq).toBe(509);
  });

  it('requests a transcript backfill once per new running session id', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    act(() => fake.emitSessionState('/abs/one', runningSession('sess-1')));
    expect(fake.requestTranscript).toHaveBeenCalledWith('sess-1');
    expect(fake.requestTranscript).toHaveBeenCalledTimes(1);

    // A later snapshot for the SAME id does not re-request.
    act(() => fake.emitSessionState('/abs/one', runningSession('sess-1')));
    expect(fake.requestTranscript).toHaveBeenCalledTimes(1);

    // A second distinct running id triggers its own single request.
    act(() => fake.emitSessionState('/abs/one', runningSession('sess-2')));
    expect(fake.requestTranscript).toHaveBeenCalledWith('sess-2');
    expect(fake.requestTranscript).toHaveBeenCalledTimes(2);
  });

  it('re-requests a transcript backfill for still-live sessions after a reconnect', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    // Connect → live session appears → transcript backfilled once.
    act(() => fake.emitStatus('connected'));
    act(() => fake.emitSessionState('/abs/one', runningSession('sess-1')));
    act(() => fake.emitSessionTranscript('/abs/one', 'sess-1', [transcriptEvent(0)]));
    expect(fake.requestTranscript).toHaveBeenCalledTimes(1);

    // Drop → reconnect: the still-live session is re-requested (events emitted
    // during the gap only exist in the server buffer).
    act(() => fake.emitStatus('disconnected'));
    act(() => fake.emitStatus('connected'));

    expect(fake.requestTranscript).toHaveBeenCalledTimes(2);
    expect(fake.requestTranscript).toHaveBeenNthCalledWith(2, 'sess-1');

    // Repeated snapshots on the SAME connection still dedupe.
    act(() => fake.emitSessionState('/abs/one', runningSession('sess-1')));
    expect(fake.requestTranscript).toHaveBeenCalledTimes(2);
  });

  it('does not request a backfill for non-running session snapshots', () => {
    const fake = makeFakeClient();
    renderHook(() => useProjects({ createClient: () => fake.client }));

    act(() =>
      fake.emitSessionState('/abs/one', { ...runningSession('sess-1'), status: 'ended' }),
    );

    expect(fake.requestTranscript).not.toHaveBeenCalled();
  });

  it('delegates requestTranscript to the underlying client', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    act(() => result.current.requestTranscript('sess-9'));

    expect(fake.requestTranscript).toHaveBeenCalledWith('sess-9');
  });

  it('delegates sendSessionInput to the underlying client', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    act(() => result.current.sendSessionInput('sess-9', 'steer me'));

    expect(fake.sendSessionInput).toHaveBeenCalledWith('sess-9', 'steer me');
  });

  it('delegates interruptSession to the underlying client', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useProjects({ createClient: () => fake.client }),
    );

    act(() => result.current.interruptSession('sess-9'));

    expect(fake.interruptSession).toHaveBeenCalledWith('sess-9');
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
