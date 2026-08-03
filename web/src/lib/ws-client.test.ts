import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWsClient,
  type BridgeState,
  type ConnectionStatus,
  type CostUsage,
  type EvidenceData,
  type ForeignNeedsYou,
  type GitState,
  type Heartbeat,
  type HookBusLiveness,
  type LifecycleSignals,
  type PermissionRequest,
  type RegistryCandidate,
  type RegistryProject,
  type RosterTimeline,
  type SessionPersona,
  type SessionState,
  type TrackerState,
  type TranscriptEvent,
  type WebSocketLike,
} from '@/lib/ws-client';

/**
 * Deterministic fake WebSocket. Records every instance so tests can assert how
 * many sockets the client opened, and exposes helpers to drive lifecycle events.
 */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0; // CONNECTING
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null = null;
  closedByClient = false;
  sent: string[] = [];

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  /** Record frames the client sends (pin/unpin). */
  send(data: string): void {
    this.sent.push(data);
  }

  /** Simulate the server accepting the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(undefined);
  }

  /** Simulate an inbound frame. */
  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Simulate the server dropping the connection. */
  serverClose(): void {
    this.readyState = 3;
    this.onclose?.(undefined);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }
}

function makeClient() {
  const statuses: ConnectionStatus[] = [];
  const heartbeats: Heartbeat[] = [];
  const client = createWsClient({
    url: 'ws://localhost/ws',
    createWebSocket: (url) => new FakeSocket(url),
  });
  client.onStatus((status) => statuses.push(status));
  client.onHeartbeat((hb) => heartbeats.push(hb));
  return { client, statuses, heartbeats };
}

function heartbeatFrame(seq: number, ts: number): string {
  return JSON.stringify({ type: 'heartbeat', seq, ts });
}

describe('ws-client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('transitions connecting -> connected on open', () => {
    const { statuses } = makeClient();

    // Subscribing synced the current status; nothing else has happened yet.
    expect(statuses).toEqual(['connecting']);
    expect(FakeSocket.instances).toHaveLength(1);

    FakeSocket.instances[0]!.open();

    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('drops malformed frames but still delivers valid heartbeats', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { heartbeats } = makeClient();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    socket.message('not json at all');
    socket.message(JSON.stringify({ type: 'not-heartbeat', seq: 1, ts: 2 }));
    socket.message(JSON.stringify({ type: 'heartbeat', seq: 'nope', ts: 2 }));
    socket.message(JSON.stringify({ type: 'heartbeat', seq: 1 })); // missing ts
    socket.message(heartbeatFrame(7, 123456)); // the only valid frame

    expect(heartbeats).toEqual([{ seq: 7, ts: 123456 }]);
    expect(warn).toHaveBeenCalled();
    // The valid frame arrived without any exception escaping the client.
    expect(warn.mock.calls.length).toBe(4);
  });

  it('schedules a reconnect on close and opens a new socket after the backoff', () => {
    makeClient();
    const first = FakeSocket.instances[0]!;
    first.open();
    first.serverClose();

    // No new socket until the backoff elapses.
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(249);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('applies exponential backoff across consecutive failures', () => {
    makeClient();
    // First socket never opens -> disconnect #1 scheduled at 250ms, backoff -> 500.
    FakeSocket.instances[0]!.serverClose();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.instances).toHaveLength(2);

    // Second socket never opens -> disconnect #2 scheduled at 500ms.
    FakeSocket.instances[1]!.serverClose();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.instances).toHaveLength(2); // not yet — needs the full 500
    vi.advanceTimersByTime(250);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('resets the backoff after a successful open', () => {
    makeClient();
    // Fail once so the backoff would grow to 500 if it were not reset.
    FakeSocket.instances[0]!.serverClose();
    vi.advanceTimersByTime(250);
    const second = FakeSocket.instances[1]!;

    // A successful open must reset the schedule back to 250ms.
    second.open();
    second.serverClose();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('close() cancels reconnects and ignores late socket events', () => {
    const { client, statuses } = makeClient();
    const first = FakeSocket.instances[0]!;
    first.open();

    client.close();
    expect(first.closedByClient).toBe(true);

    // A late server close on the torn-down socket must not schedule a reconnect...
    first.serverClose();
    vi.advanceTimersByTime(10000);
    expect(FakeSocket.instances).toHaveLength(1);

    // ...and no status is emitted to already-removed subscribers after close.
    expect(statuses).toEqual(['connecting', 'connected']);
  });
});

describe('ws-client dial protocols', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDialClient(getAuthToken: () => string | null) {
    const dials: (string | string[] | undefined)[] = [];
    createWsClient({
      url: 'ws://localhost/ws',
      getAuthToken,
      createWebSocket: (url, protocols) => {
        dials.push(protocols);
        return new FakeSocket(url);
      },
    });
    return dials;
  }

  it('offers both devos and token.<token> when a token is injected', () => {
    const dials = makeDialClient(() => 'secret-hex');

    expect(dials).toHaveLength(1);
    expect(dials[0]).toEqual(['devos', 'token.secret-hex']);
  });

  it('offers only devos when the token is null', () => {
    const dials = makeDialClient(() => null);

    expect(dials).toHaveLength(1);
    expect(dials[0]).toEqual(['devos']);
  });

  it('offers only devos when the token is an empty string', () => {
    const dials = makeDialClient(() => '');

    expect(dials).toHaveLength(1);
    expect(dials[0]).toEqual(['devos']);
  });
});

/** A well-formed registry entry matching the ProjectAnchor contract. */
function sampleProject(path: string): RegistryProject {
  return {
    path,
    displayName: 'Sample',
    pinned: true,
    uiPrefs: { theme: 'dark' },
    createdAt: 1700000000000,
  };
}

function registryFrame(projects: readonly unknown[]): string {
  return JSON.stringify({ type: 'registry', projects });
}

describe('ws-client pin/unpin', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pin() sends a pin frame once the socket is OPEN', () => {
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.pin('/abs/path/to/project');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'pin', path: '/abs/path/to/project' }),
    ]);
  });

  it('pin() with opts includes displayName and uiPrefs', () => {
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.pin('/abs/path', { displayName: 'My Project', uiPrefs: { theme: 'dark' } });

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'pin',
      path: '/abs/path',
      displayName: 'My Project',
      uiPrefs: { theme: 'dark' },
    });
  });

  it('unpin() sends an unpin frame once the socket is OPEN', () => {
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.unpin('/abs/path/to/project');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'unpin', path: '/abs/path/to/project' }),
    ]);
  });

  it('drops (and warns) when pin() is called before the socket is OPEN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    // NOTE: socket is still CONNECTING (readyState 0) — never opened.

    client.pin('/abs/path');
    client.unpin('/abs/path');

    expect(socket.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('ws-client registry frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRegistryClient() {
    const received: (readonly RegistryProject[])[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onRegistry((projects) => received.push(projects));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid registry frame as a frozen projects array', () => {
    const { received, socket } = makeRegistryClient();
    const project = sampleProject('/abs/one');

    socket.message(registryFrame([project]));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([project]);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(Object.isFrozen(received[0]![0])).toBe(true);
  });

  it('stops delivery after the returned unsubscribe is called', () => {
    const { received, off, socket } = makeRegistryClient();

    socket.message(registryFrame([sampleProject('/abs/one')]));
    expect(received).toHaveLength(1);

    off();
    socket.message(registryFrame([sampleProject('/abs/two')]));
    expect(received).toHaveLength(1); // no further delivery
  });

  it('drops malformed registry frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeRegistryClient();

    socket.message(42); // non-string data
    socket.message('{ not json'); // bad JSON
    socket.message(JSON.stringify({ type: 'registry' })); // missing projects
    socket.message(JSON.stringify({ type: 'not-registry', projects: [] })); // wrong type
    socket.message(registryFrame([{ path: 123 }])); // malformed entry

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

/** A well-formed candidate entry matching the Candidate contract. */
function sampleCandidate(path: string): RegistryCandidate {
  return { path, displayName: 'p', hasClaudeInstall: true };
}

function candidatesFrame(candidates: readonly unknown[]): string {
  return JSON.stringify({ type: 'candidates', candidates });
}

describe('ws-client candidates frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCandidatesClient() {
    const received: (readonly RegistryCandidate[])[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onCandidates((candidates) => received.push(candidates));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid candidates frame as a frozen candidates array', () => {
    const { received, socket } = makeCandidatesClient();
    const candidate = sampleCandidate('/p');

    socket.message(candidatesFrame([candidate]));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([candidate]);
    expect(received[0]![0]).toEqual({
      path: '/p',
      displayName: 'p',
      hasClaudeInstall: true,
    });
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(Object.isFrozen(received[0]![0])).toBe(true);
  });

  it('drops malformed candidates frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeCandidatesClient();

    // Entry missing hasClaudeInstall.
    socket.message(candidatesFrame([{ path: '/p', displayName: 'p' }]));
    // candidates not an array.
    socket.message(JSON.stringify({ type: 'candidates', candidates: 'nope' }));

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('ws-client discover', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discover() sends a discover frame once the socket is OPEN', () => {
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.discover();

    expect(socket.sent).toEqual([JSON.stringify({ type: 'discover' })]);
  });

  it('drops (and warns) when discover() is called before the socket is OPEN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    // NOTE: socket is still CONNECTING (readyState 0) — never opened.

    client.discover();

    expect(socket.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/** A well-formed git-state snapshot matching the GitState contract. */
function sampleGitState(path: string): GitState {
  return {
    path,
    isRepo: true,
    branch: 'main',
    detached: false,
    dirty: true,
    ahead: 2,
    behind: 1,
    upstream: 'origin/main',
  };
}

function gitStateFrame(path: string, state: unknown): string {
  return JSON.stringify({ type: 'git-state', path, state });
}

describe('ws-client git-state frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeGitStateClient() {
    const received: { path: string; state: GitState }[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onGitState((path, state) => received.push({ path, state }));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid git-state frame with the correct path and a frozen state', () => {
    const { received, socket } = makeGitStateClient();
    const state = sampleGitState('/abs/repo');

    socket.message(gitStateFrame('/abs/repo', state));

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/abs/repo');
    expect(received[0]!.state).toEqual(state);
    expect(Object.isFrozen(received[0]!.state)).toBe(true);
  });

  it('round-trips the no-upstream shape (null ahead/behind/upstream) unchanged', () => {
    const { received, socket } = makeGitStateClient();
    const noUpstream: GitState = {
      path: '/abs/repo',
      isRepo: true,
      branch: 'feature',
      detached: false,
      dirty: false,
      ahead: null,
      behind: null,
      upstream: null,
    };

    socket.message(gitStateFrame('/abs/repo', noUpstream));

    expect(received).toHaveLength(1);
    // Nulls must survive the validator, NOT be coerced to 0.
    expect(received[0]!.state.ahead).toBeNull();
    expect(received[0]!.state.behind).toBeNull();
    expect(received[0]!.state.upstream).toBeNull();
    expect(received[0]!.state).toEqual(noUpstream);
  });

  it('drops malformed git-state frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeGitStateClient();
    const base = sampleGitState('/abs/repo');

    // Missing state entirely.
    expect(() =>
      socket.message(JSON.stringify({ type: 'git-state', path: '/abs/repo' })),
    ).not.toThrow();
    // state.ahead a string.
    expect(() =>
      socket.message(gitStateFrame('/abs/repo', { ...base, ahead: '2' })),
    ).not.toThrow();
    // state.isRepo non-boolean.
    expect(() =>
      socket.message(gitStateFrame('/abs/repo', { ...base, isRepo: 'yes' })),
    ).not.toThrow();
    // state.branch a number.
    expect(() =>
      socket.message(gitStateFrame('/abs/repo', { ...base, branch: 42 })),
    ).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('requestGitState() sends a git-state frame once the socket is OPEN', () => {
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.requestGitState('/abs/repo');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'git-state', path: '/abs/repo' }),
    ]);
  });

  it('drops (and warns) when requestGitState() is called before the socket is OPEN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    // NOTE: socket is still CONNECTING (readyState 0) — never opened.

    client.requestGitState('/abs/repo');

    expect(socket.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('close() drops git-state subscribers', () => {
    const { client, received, socket } = makeGitStateClient();

    socket.message(gitStateFrame('/abs/repo', sampleGitState('/abs/repo')));
    expect(received).toHaveLength(1);

    client.close();

    // After close, the socket is detached and subscribers are cleared; emitting
    // again must not reach the listener.
    socket.onmessage?.({ data: gitStateFrame('/abs/repo', sampleGitState('/abs/repo')) });
    expect(received).toHaveLength(1);
  });
});

/** A well-formed tracker-state snapshot matching the TrackerState contract. */
function sampleTrackerState(path: string): TrackerState {
  return {
    path,
    reachable: true,
    tracker: 'todoist',
    nextTask: {
      id: '42',
      title: 'Ship the tracker gateway',
      priority: 4,
      url: 'https://todoist.com/task/42',
    },
  };
}

function trackerStateFrame(path: string, state: unknown): string {
  return JSON.stringify({ type: 'tracker-state', path, state });
}

function sampleLifecycleSignals(overrides: Partial<LifecycleSignals> = {}): LifecycleSignals {
  return {
    hasDecideDocs: false,
    hasDefineDocs: true,
    hasStartedStory: false,
    hasFeatureBranchCommits: false,
    hasReleaseTags: false,
    ...overrides,
  };
}

function lifecycleSignalsFrame(path: string, signals: unknown): string {
  return JSON.stringify({ type: 'lifecycle-signals', path, state: { path, signals } });
}

describe('ws-client lifecycle-signals frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeLifecycleSignalsClient() {
    const received: { path: string; signals: LifecycleSignals }[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onLifecycleSignals((path, signals) => received.push({ path, signals }));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid lifecycle-signals frame with the correct path and frozen signals', () => {
    const { received, socket } = makeLifecycleSignalsClient();
    const signals = sampleLifecycleSignals({ hasStartedStory: true });

    socket.message(lifecycleSignalsFrame('/abs/repo', signals));

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/abs/repo');
    expect(received[0]!.signals).toEqual(signals);
    expect(Object.isFrozen(received[0]!.signals)).toBe(true);
  });

  it('drops malformed lifecycle-signals frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeLifecycleSignalsClient();

    // A signal field is non-boolean.
    expect(() =>
      socket.message(
        lifecycleSignalsFrame('/abs/repo', { ...sampleLifecycleSignals(), hasDefineDocs: 'yes' }),
      ),
    ).not.toThrow();
    // A signal field is missing.
    expect(() =>
      socket.message(lifecycleSignalsFrame('/abs/repo', { hasDefineDocs: true })),
    ).not.toThrow();
    // Missing path on the frame.
    expect(() =>
      socket.message(
        JSON.stringify({ type: 'lifecycle-signals', state: { signals: sampleLifecycleSignals() } }),
      ),
    ).not.toThrow();
    // Missing state entirely.
    expect(() =>
      socket.message(JSON.stringify({ type: 'lifecycle-signals', path: '/abs/repo' })),
    ).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('requestLifecycleSignals() sends a lifecycle-signals frame once the socket is OPEN', () => {
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.requestLifecycleSignals('/abs/repo');

    expect(socket.sent).toEqual([JSON.stringify({ type: 'lifecycle-signals', path: '/abs/repo' })]);
  });

  it('drops (and warns) when requestLifecycleSignals() is called before the socket is OPEN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    // NOTE: socket still CONNECTING — never opened.

    client.requestLifecycleSignals('/abs/repo');

    expect(socket.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('close() drops lifecycle-signals subscribers', () => {
    const { client, received, socket } = makeLifecycleSignalsClient();

    socket.message(lifecycleSignalsFrame('/abs/repo', sampleLifecycleSignals()));
    expect(received).toHaveLength(1);

    client.close();

    socket.onmessage?.({ data: lifecycleSignalsFrame('/abs/repo', sampleLifecycleSignals()) });
    expect(received).toHaveLength(1);
  });
});

describe('ws-client tracker-state frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTrackerStateClient() {
    const received: { path: string; state: TrackerState }[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onTrackerState((path, state) => received.push({ path, state }));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid tracker-state frame with the correct path and a frozen state', () => {
    const { received, socket } = makeTrackerStateClient();
    const state = sampleTrackerState('/abs/repo');

    socket.message(trackerStateFrame('/abs/repo', state));

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/abs/repo');
    expect(received[0]!.state).toEqual(state);
    expect(Object.isFrozen(received[0]!.state)).toBe(true);
    // The nested nextTask must also survive frozen.
    expect(Object.isFrozen(received[0]!.state.nextTask)).toBe(true);
  });

  it('round-trips an unreachable snapshot (null tracker/nextTask) unchanged', () => {
    const { received, socket } = makeTrackerStateClient();
    const unreachable: TrackerState = {
      path: '/abs/repo',
      reachable: false,
      tracker: null,
      nextTask: null,
    };

    socket.message(trackerStateFrame('/abs/repo', unreachable));

    expect(received).toHaveLength(1);
    // Nulls must survive the validator, NOT be coerced.
    expect(received[0]!.state.reachable).toBe(false);
    expect(received[0]!.state.tracker).toBeNull();
    expect(received[0]!.state.nextTask).toBeNull();
    expect(received[0]!.state).toEqual(unreachable);
  });

  it('drops malformed tracker-state frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeTrackerStateClient();
    const base = sampleTrackerState('/abs/repo');

    // Missing path on the frame.
    expect(() =>
      socket.message(JSON.stringify({ type: 'tracker-state', state: base })),
    ).not.toThrow();
    // Missing state entirely.
    expect(() =>
      socket.message(JSON.stringify({ type: 'tracker-state', path: '/abs/repo' })),
    ).not.toThrow();
    // state.reachable non-boolean.
    expect(() =>
      socket.message(trackerStateFrame('/abs/repo', { ...base, reachable: 'yes' })),
    ).not.toThrow();
    // state.tracker a number.
    expect(() =>
      socket.message(trackerStateFrame('/abs/repo', { ...base, tracker: 42 })),
    ).not.toThrow();
    // state.nextTask malformed (missing id).
    expect(() =>
      socket.message(
        trackerStateFrame('/abs/repo', {
          ...base,
          nextTask: { title: 'no id', priority: 4, url: null },
        }),
      ),
    ).not.toThrow();
    // state not an object.
    expect(() =>
      socket.message(JSON.stringify({ type: 'tracker-state', path: '/abs/repo', state: 'nope' })),
    ).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('requestTrackerState() sends a tracker-state frame once the socket is OPEN', () => {
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.requestTrackerState('/abs/repo');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'tracker-state', path: '/abs/repo' }),
    ]);
  });

  it('drops (and warns) when requestTrackerState() is called before the socket is OPEN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient();
    const socket = FakeSocket.instances[0]!;
    // NOTE: socket is still CONNECTING (readyState 0) — never opened.

    client.requestTrackerState('/abs/repo');

    expect(socket.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('close() drops tracker-state subscribers', () => {
    const { client, received, socket } = makeTrackerStateClient();

    socket.message(trackerStateFrame('/abs/repo', sampleTrackerState('/abs/repo')));
    expect(received).toHaveLength(1);

    client.close();

    // After close, the socket is detached and subscribers are cleared; emitting
    // again must not reach the listener.
    socket.onmessage?.({
      data: trackerStateFrame('/abs/repo', sampleTrackerState('/abs/repo')),
    });
    expect(received).toHaveLength(1);
  });
});

/** A well-formed session-state snapshot matching the SessionState contract. */
function sampleSessionState(id: string, path: string): SessionState {
  return {
    id,
    projectPath: path,
    role: 'builder',
    status: 'running',
    sdkSessionId: null,
    workItemId: null,
    rateLimited: false,
  };
}

function sessionStateFrame(path: string, session: unknown): string {
  return JSON.stringify({ type: 'session-state', path, session });
}

describe('ws-client session-state frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeSessionClient() {
    const received: { path: string; session: SessionState }[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onSessionState((path, session) => received.push({ path, session }));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid session-state frame with the correct path and a frozen session', () => {
    const { received, socket } = makeSessionClient();
    const session = sampleSessionState('sess-1', '/abs/repo');

    socket.message(sessionStateFrame('/abs/repo', session));

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/abs/repo');
    expect(received[0]!.session).toEqual(session);
    expect(Object.isFrozen(received[0]!.session)).toBe(true);
  });

  it('round-trips a non-null workItemId and a true rateLimited flag', () => {
    const { received, socket } = makeSessionClient();
    const session = {
      ...sampleSessionState('sess-1', '/abs/repo'),
      workItemId: 'WI-9',
      rateLimited: true,
    };

    socket.message(sessionStateFrame('/abs/repo', session));

    expect(received).toHaveLength(1);
    expect(received[0]!.session.workItemId).toBe('WI-9');
    expect(received[0]!.session.rateLimited).toBe(true);
  });

  it('drops malformed session-state frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeSessionClient();
    const base = sampleSessionState('sess-1', '/abs/repo');

    // Missing session entirely.
    expect(() =>
      socket.message(JSON.stringify({ type: 'session-state', path: '/abs/repo' })),
    ).not.toThrow();
    // session.id empty.
    expect(() =>
      socket.message(sessionStateFrame('/abs/repo', { ...base, id: '' })),
    ).not.toThrow();
    // session.status non-string.
    expect(() =>
      socket.message(sessionStateFrame('/abs/repo', { ...base, status: 42 })),
    ).not.toThrow();
    // session.sdkSessionId a number (must be string|null).
    expect(() =>
      socket.message(sessionStateFrame('/abs/repo', { ...base, sdkSessionId: 7 })),
    ).not.toThrow();
    // session.workItemId a number (must be string|null).
    expect(() =>
      socket.message(sessionStateFrame('/abs/repo', { ...base, workItemId: 7 })),
    ).not.toThrow();
    // session.rateLimited missing entirely (required on the wire).
    expect(() => {
      const { rateLimited: _rateLimited, ...withoutRateLimited } = { ...base, workItemId: null };
      socket.message(sessionStateFrame('/abs/repo', withoutRateLimited));
    }).not.toThrow();
    // session.rateLimited non-boolean.
    expect(() =>
      socket.message(sessionStateFrame('/abs/repo', { ...base, rateLimited: 'yes' })),
    ).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('spawnSession() sends a session-spawn frame once the socket is OPEN', () => {
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.spawnSession('/abs/repo', 'reviewer', 'WI-9');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'session-spawn', path: '/abs/repo', role: 'reviewer', workItemId: 'WI-9' }),
    ]);
  });
});

/** A well-formed session-persona entry matching the SessionPersona contract. */
function samplePersona(sessionId: string): SessionPersona {
  return {
    sessionId,
    workItemId: 'WI-9',
    role: 'builder',
    phase: 'coding',
    persona: 'Shipwright',
  };
}

function personasFrame(path: string, personas: unknown): string {
  return JSON.stringify({ type: 'session-personas', path, personas });
}

describe('ws-client session-personas frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makePersonasClient() {
    const received: { path: string; personas: readonly SessionPersona[] }[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onSessionPersonas((path, personas) => received.push({ path, personas }));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid session-personas snapshot with the correct path and frozen personas', () => {
    const { received, socket } = makePersonasClient();
    const personas = [samplePersona('sess-1'), samplePersona('sess-2')];

    socket.message(personasFrame('/abs/repo', personas));

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/abs/repo');
    expect(received[0]!.personas).toEqual(personas);
    expect(Object.isFrozen(received[0]!.personas)).toBe(true);
    expect(Object.isFrozen(received[0]!.personas[0])).toBe(true);
  });

  it('drops malformed session-personas frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makePersonasClient();
    const persona = samplePersona('sess-1');

    // path missing.
    expect(() =>
      socket.message(JSON.stringify({ type: 'session-personas', personas: [persona] })),
    ).not.toThrow();
    // personas not an array.
    expect(() =>
      socket.message(JSON.stringify({ type: 'session-personas', path: '/abs/repo', personas: {} })),
    ).not.toThrow();
    // one entry malformed (sessionId empty) drops the whole frame.
    expect(() =>
      socket.message(personasFrame('/abs/repo', [{ ...persona, sessionId: '' }])),
    ).not.toThrow();
    // one entry malformed (role non-string) drops the whole frame.
    expect(() =>
      socket.message(personasFrame('/abs/repo', [{ ...persona, role: 42 }])),
    ).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('requestSessionPersonas() sends a session-personas frame once the socket is OPEN', () => {
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.requestSessionPersonas('/abs/repo');

    expect(socket.sent).toEqual([JSON.stringify({ type: 'session-personas', path: '/abs/repo' })]);
  });
});

describe('ws-client roster-timeline frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function rosterTimelineFrame(path: string, roles: unknown): string {
    return JSON.stringify({ type: 'roster-timeline', path, roles });
  }

  function makeRosterTimelineClient() {
    const received: { path: string; timeline: RosterTimeline }[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    client.onRosterTimeline((path, timeline) => received.push({ path, timeline }));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, socket };
  }

  it('delivers a valid roster-timeline snapshot with the correct path and frozen roles', () => {
    const { received, socket } = makeRosterTimelineClient();
    const roles = [
      {
        role: 'builder',
        phases: [
          { phase: 'planning', persona: 'Navigator' },
          { phase: 'coding', persona: 'Shipwright' },
        ],
      },
      { role: 'reviewer', phases: [{ phase: 'reviewing', persona: 'Warden' }] },
    ];

    socket.message(rosterTimelineFrame('/abs/repo', roles));

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/abs/repo');
    expect(received[0]!.timeline).toEqual({ path: '/abs/repo', roles });
    expect(Object.isFrozen(received[0]!.timeline)).toBe(true);
    expect(Object.isFrozen(received[0]!.timeline.roles)).toBe(true);
    expect(Object.isFrozen(received[0]!.timeline.roles[0])).toBe(true);
    expect(Object.isFrozen(received[0]!.timeline.roles[0]!.phases[0])).toBe(true);
  });

  it('drops malformed roster-timeline frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeRosterTimelineClient();

    // path missing.
    expect(() =>
      socket.message(
        JSON.stringify({
          type: 'roster-timeline',
          roles: [{ role: 'builder', phases: [] }],
        }),
      ),
    ).not.toThrow();
    // roles not an array.
    expect(() => socket.message(rosterTimelineFrame('/abs/repo', {}))).not.toThrow();
    // a role missing its phases array.
    expect(() =>
      socket.message(rosterTimelineFrame('/abs/repo', [{ role: 'builder' }])),
    ).not.toThrow();
    // a phase entry missing its persona.
    expect(() =>
      socket.message(
        rosterTimelineFrame('/abs/repo', [
          { role: 'builder', phases: [{ phase: 'coding' }] },
        ]),
      ),
    ).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('requestRosterTimeline() sends a roster-timeline frame once the socket is OPEN', () => {
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.requestRosterTimeline('/abs/repo');

    expect(socket.sent).toEqual([JSON.stringify({ type: 'roster-timeline', path: '/abs/repo' })]);
  });
});

/** Stamp a transcript event body with sessionId/seq/ts for fixture frames. */
function stamped(body: Record<string, unknown>, seq: number): Record<string, unknown> {
  return { ...body, sessionId: 'sess-1', seq, ts: 1700000000000 + seq };
}

/** One well-formed event of every kind, in stream order. */
function sampleTranscriptEvents(): Record<string, unknown>[] {
  return [
    stamped({ kind: 'init' }, 0),
    stamped({ kind: 'assistant-text', text: 'Reading the plan' }, 1),
    stamped({ kind: 'tool-use', toolName: 'Bash', toolInput: '{"command":"ls"}', toolUseId: 'tu-1' }, 2),
    stamped({ kind: 'tool-result', toolUseId: 'tu-1', content: 'src\ntest', isError: false }, 3),
    stamped(
      {
        kind: 'result',
        durationMs: 1234,
        numTurns: 3,
        totalCostUsd: 0.05,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        isError: false,
      },
      4,
    ),
  ];
}

function transcriptFrame(events: readonly unknown[]): string {
  return JSON.stringify({
    type: 'session-transcript',
    path: '/abs/repo',
    sessionId: 'sess-1',
    events,
  });
}

describe('ws-client session-transcript frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTranscriptClient() {
    const received: {
      path: string;
      sessionId: string;
      events: readonly TranscriptEvent[];
    }[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onSessionTranscript((path, sessionId, events) =>
      received.push({ path, sessionId, events }),
    );
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid session-transcript frame with every kind parsed and frozen', () => {
    const { received, socket } = makeTranscriptClient();
    const events = sampleTranscriptEvents();

    socket.message(transcriptFrame(events));

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/abs/repo');
    expect(received[0]!.sessionId).toBe('sess-1');
    expect(received[0]!.events).toEqual(events);
    expect(received[0]!.events.map((e) => e.kind)).toEqual([
      'init',
      'assistant-text',
      'tool-use',
      'tool-result',
      'result',
    ]);
    expect(Object.isFrozen(received[0]!.events)).toBe(true);
    for (const event of received[0]!.events) {
      expect(Object.isFrozen(event)).toBe(true);
    }
  });

  it('accepts null toolUseId on tool-use and tool-result events', () => {
    const { received, socket } = makeTranscriptClient();

    socket.message(
      transcriptFrame([
        stamped({ kind: 'tool-use', toolName: 'Read', toolInput: '{}', toolUseId: null }, 0),
        stamped({ kind: 'tool-result', toolUseId: null, content: 'ok', isError: true }, 1),
      ]),
    );

    expect(received).toHaveLength(1);
    const [use, result] = received[0]!.events;
    expect(use).toMatchObject({ kind: 'tool-use', toolUseId: null });
    expect(result).toMatchObject({ kind: 'tool-result', toolUseId: null, isError: true });
  });

  it('drops malformed session-transcript frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeTranscriptClient();

    // Unknown kind.
    socket.message(transcriptFrame([stamped({ kind: 'mystery' }, 0)]));
    // assistant-text missing text.
    socket.message(transcriptFrame([stamped({ kind: 'assistant-text' }, 0)]));
    // tool-use with non-string toolName.
    socket.message(
      transcriptFrame([stamped({ kind: 'tool-use', toolName: 7, toolInput: '{}', toolUseId: null }, 0)]),
    );
    // tool-result with non-boolean isError.
    socket.message(
      transcriptFrame([stamped({ kind: 'tool-result', toolUseId: null, content: 'x', isError: 'no' }, 0)]),
    );
    // result with a non-finite metric.
    socket.message(
      transcriptFrame([
        stamped(
          {
            kind: 'result',
            durationMs: Number.NaN,
            numTurns: 1,
            totalCostUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            isError: false,
          },
          0,
        ),
      ]),
    );
    // Missing seq stamp.
    socket.message(
      transcriptFrame([{ kind: 'init', sessionId: 'sess-1', ts: 1700000000000 }]),
    );
    // Missing sessionId on the frame.
    socket.message(
      JSON.stringify({ type: 'session-transcript', path: '/abs/repo', events: [] }),
    );
    // events not an array.
    socket.message(
      JSON.stringify({
        type: 'session-transcript',
        path: '/abs/repo',
        sessionId: 'sess-1',
        events: 'nope',
      }),
    );

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('stops delivery after the returned unsubscribe is called', () => {
    const { received, off, socket } = makeTranscriptClient();

    socket.message(transcriptFrame([stamped({ kind: 'init' }, 0)]));
    expect(received).toHaveLength(1);

    off();
    socket.message(transcriptFrame([stamped({ kind: 'init' }, 1)]));
    expect(received).toHaveLength(1); // no further delivery
  });

  it('parses a user-text event (the human steer echo) and drops a non-string text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeTranscriptClient();

    socket.message(transcriptFrame([stamped({ kind: 'user-text', text: 'focus on auth' }, 0)]));
    expect(received).toHaveLength(1);
    expect(received[0]!.events[0]).toMatchObject({ kind: 'user-text', text: 'focus on auth' });
    expect(Object.isFrozen(received[0]!.events[0])).toBe(true);

    // A user-text event with a non-string text is malformed → whole frame dropped.
    socket.message(transcriptFrame([stamped({ kind: 'user-text', text: 42 }, 1)]));
    expect(received).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('requestTranscript() sends a session-transcript-request frame once the socket is OPEN', () => {
    const { client, socket } = makeTranscriptClient();

    client.requestTranscript('sess-1');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'session-transcript-request', sessionId: 'sess-1' }),
    ]);
  });

  it('sendSessionInput() sends a session-input frame once the socket is OPEN', () => {
    const { client, socket } = makeTranscriptClient();

    client.sendSessionInput('sess-1', 'refactor the parser');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'session-input', sessionId: 'sess-1', text: 'refactor the parser' }),
    ]);
  });

  it('interruptSession() sends a session-interrupt frame once the socket is OPEN', () => {
    const { client, socket } = makeTranscriptClient();

    client.interruptSession('sess-1');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'session-interrupt', sessionId: 'sess-1' }),
    ]);
  });

  it('drops (and warns) when steer/interrupt senders are called before the socket is OPEN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    // NOTE: socket is still CONNECTING (readyState 0) — never opened.

    client.sendSessionInput('sess-1', 'x');
    client.interruptSession('sess-1');

    expect(socket.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops (and warns) when requestTranscript() is called before the socket is OPEN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    // NOTE: socket is still CONNECTING (readyState 0) — never opened.

    client.requestTranscript('sess-1');

    expect(socket.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  function makeBridgeStateClient() {
    const received: { path: string; state: BridgeState }[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    client.onBridgeState((path, state) => received.push({ path, state }));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, socket };
  }

  it('parses and exposes a valid bridge-state frame', () => {
    const { received, socket } = makeBridgeStateClient();
    const frame = {
      type: 'bridge-state',
      path: '/abs/repo',
      stage: 'implement',
      gate: 'awaiting-approval',
      sessionId: 'sess-1',
      inbox: [{ stage: 'implement', kind: 'question', reason: 'need input', ts: 123 }],
    };

    socket.message(JSON.stringify(frame));

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/abs/repo');
    expect(received[0]!.state).toEqual({
      path: '/abs/repo',
      stage: 'implement',
      gate: 'awaiting-approval',
      sessionId: 'sess-1',
      inbox: [{ stage: 'implement', kind: 'question', reason: 'need input', ts: 123 }],
      reworkCount: 0,
    });
    expect(Object.isFrozen(received[0]!.state)).toBe(true);
  });

  it('preserves a present reworkCount on a bridge-state frame', () => {
    const { received, socket } = makeBridgeStateClient();
    const frame = {
      type: 'bridge-state',
      path: '/abs/repo',
      stage: 'implement',
      gate: 'reworking',
      sessionId: 'sess-1',
      inbox: [],
      reworkCount: 2,
    };

    socket.message(JSON.stringify(frame));

    expect(received).toHaveLength(1);
    expect(received[0]!.state.reworkCount).toBe(2);
  });

  it('drops a malformed bridge-state frame without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeBridgeStateClient();

    socket.message(
      JSON.stringify({
        type: 'bridge-state',
        path: '/abs/repo',
        stage: 'implement',
        gate: 'not-a-real-gate',
        sessionId: null,
        inbox: [],
      }),
    );

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('parses a bridge-state frame carrying a chips-bearing question item, chips preserved', () => {
    const { received, socket } = makeBridgeStateClient();
    const frame = {
      type: 'bridge-state',
      path: '/abs/repo',
      stage: 'implement',
      gate: 'awaiting-approval',
      sessionId: 'sess-1',
      inbox: [
        { stage: 'implement', kind: 'question', reason: 'pick one', ts: 123, chips: ['A', 'B'] },
      ],
    };

    socket.message(JSON.stringify(frame));

    expect(received).toHaveLength(1);
    expect(received[0]!.state.inbox).toEqual([
      { stage: 'implement', kind: 'question', reason: 'pick one', ts: 123, chips: ['A', 'B'] },
    ]);
    expect(Object.isFrozen(received[0]!.state.inbox[0])).toBe(true);
  });

  it('keeps chips absent when the raw item has no chips field', () => {
    const { received, socket } = makeBridgeStateClient();
    const frame = {
      type: 'bridge-state',
      path: '/abs/repo',
      stage: 'implement',
      gate: 'awaiting-approval',
      sessionId: 'sess-1',
      inbox: [{ stage: 'implement', kind: 'question', reason: 'approve?', ts: 123 }],
    };

    socket.message(JSON.stringify(frame));

    expect(received).toHaveLength(1);
    expect(received[0]!.state.inbox[0]).not.toHaveProperty('chips');
  });

  it('drops a bridge-state frame whose inbox item has a non-string chip element', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeBridgeStateClient();
    const frame = {
      type: 'bridge-state',
      path: '/abs/repo',
      stage: 'implement',
      gate: 'awaiting-approval',
      sessionId: 'sess-1',
      inbox: [{ stage: 'implement', kind: 'question', reason: 'pick one', ts: 123, chips: ['A', 42] }],
    };

    socket.message(JSON.stringify(frame));

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('caps chips to 8 entries of 512 chars each', () => {
    const { received, socket } = makeBridgeStateClient();
    const chips = Array.from({ length: 10 }, (_, i) => `chip-${i}-` + 'x'.repeat(600));
    const frame = {
      type: 'bridge-state',
      path: '/abs/repo',
      stage: 'implement',
      gate: 'awaiting-approval',
      sessionId: 'sess-1',
      inbox: [{ stage: 'implement', kind: 'question', reason: 'pick one', ts: 123, chips }],
    };

    socket.message(JSON.stringify(frame));

    expect(received).toHaveLength(1);
    const gotChips = received[0]!.state.inbox[0]!.chips!;
    expect(gotChips).toHaveLength(8);
    for (const chip of gotChips) {
      expect(chip.length).toBeLessThanOrEqual(512);
    }
  });

  it('sendQuestionAnswer/sendEscalationChoice send the matching inbound frames', () => {
    const { client, socket } = makeBridgeStateClient();

    client.sendQuestionAnswer('/abs/repo', 'yes please');
    client.sendEscalationChoice('/abs/repo', 'take-over');
    client.sendEscalationChoice('/abs/repo', 'give-guidance', 'try approach B');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'question-answer', path: '/abs/repo', answer: 'yes please' }),
      JSON.stringify({ type: 'escalation-choice', path: '/abs/repo', choice: 'take-over' }),
      JSON.stringify({
        type: 'escalation-choice',
        path: '/abs/repo',
        choice: 'give-guidance',
        notes: 'try approach B',
      }),
    ]);
  });

  it('sendBridgeStart/sendGateApprove/sendBridgeInterrupt send the matching inbound frames', () => {
    const { client, socket } = makeBridgeStateClient();

    client.sendBridgeStart('/abs/repo', 'wi-1');
    client.sendGateApprove('/abs/repo');
    client.sendBridgeInterrupt('/abs/repo', 'stop please');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'bridge-start', path: '/abs/repo', workItemId: 'wi-1' }),
      JSON.stringify({ type: 'gate-approve', path: '/abs/repo' }),
      JSON.stringify({ type: 'bridge-interrupt', path: '/abs/repo', reason: 'stop please' }),
    ]);
  });

  it('sendPermissionDecision() sends a permission-decision frame with "allow-always" once the socket is OPEN', () => {
    const { client, socket } = makeBridgeStateClient();

    client.sendPermissionDecision('sess-1', 'req9', 'allow-always');

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: 'permission-decision',
        sessionId: 'sess-1',
        requestId: 'req9',
        decision: 'allow-always',
      }),
    ]);
  });

  it('sendPermissionDecision() sends "allow" and "deny" frames unchanged', () => {
    const { client, socket } = makeBridgeStateClient();

    client.sendPermissionDecision('sess-1', 'req9', 'allow');
    client.sendPermissionDecision('sess-1', 'req9', 'deny');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'permission-decision', sessionId: 'sess-1', requestId: 'req9', decision: 'allow' }),
      JSON.stringify({ type: 'permission-decision', sessionId: 'sess-1', requestId: 'req9', decision: 'deny' }),
    ]);
  });

  it('drops (and warns) when sendPermissionDecision() is called before the socket is OPEN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    // NOTE: socket is still CONNECTING (readyState 0) — never opened.

    client.sendPermissionDecision('sess-1', 'req9', 'allow-always');

    expect(socket.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('parses a "permission" transcript event carrying decision "allow-always"', () => {
    const { received, socket } = makeTranscriptClient();

    socket.message(
      transcriptFrame([
        stamped({ kind: 'permission', requestId: 'req9', toolName: 'Write', decision: 'allow-always' }, 0),
      ]),
    );

    expect(received).toHaveLength(1);
    expect(received[0]!.events[0]).toMatchObject({
      kind: 'permission',
      requestId: 'req9',
      toolName: 'Write',
      decision: 'allow-always',
    });
    expect(Object.isFrozen(received[0]!.events[0])).toBe(true);
  });

  it('drops a "permission" transcript event carrying an unknown decision string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeTranscriptClient();

    socket.message(
      transcriptFrame([
        stamped({ kind: 'permission', requestId: 'req9', toolName: 'Write', decision: 'maybe-later' }, 0),
      ]),
    );

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

/** A well-formed foreign-session needs-you frame body. */
function sampleForeignNeedsYou(): ForeignNeedsYou {
  return {
    path: '/abs/other',
    sessionId: 'foreign-1',
    kind: 'idle_prompt',
    reason: 'Waiting for input',
    ts: 1700000000000,
    cleared: false,
  };
}

function foreignNeedsYouFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'foreign-session-needs-you', ...sampleForeignNeedsYou(), ...overrides });
}

describe('ws-client foreign-session-needs-you frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeForeignNeedsYouClient() {
    const received: ForeignNeedsYou[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onForeignNeedsYou((item) => received.push(item));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid foreign-session-needs-you frame as a frozen item, including cleared', () => {
    const { received, socket } = makeForeignNeedsYouClient();
    const item = sampleForeignNeedsYou();

    socket.message(foreignNeedsYouFrame());

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(item);
    expect(received[0]!.cleared).toBe(false);
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it('drops malformed foreign-session-needs-you frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeForeignNeedsYouClient();

    expect(() => socket.message(foreignNeedsYouFrame({ sessionId: '' }))).not.toThrow();
    expect(() => socket.message(foreignNeedsYouFrame({ kind: 'not-a-kind' }))).not.toThrow();
    expect(() => socket.message(foreignNeedsYouFrame({ cleared: 'nope' }))).not.toThrow();
    expect(() => socket.message(foreignNeedsYouFrame({ ts: 'not-a-number' }))).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

/** A well-formed permission-request frame body. */
function samplePermissionRequest(): PermissionRequest {
  return {
    path: '/abs/proj',
    sessionId: 'sess-1',
    requestId: 'req-1',
    toolUseId: 'tu-1',
    toolName: 'Bash',
    title: 'run a command',
    input: '{"command":"ls"}',
    ts: 1700000000000,
  };
}

function permissionRequestFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'permission-request', ...samplePermissionRequest(), ...overrides });
}

describe('ws-client permission-request frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makePermissionRequestClient() {
    const received: PermissionRequest[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onPermissionRequest((request) => received.push(request));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid permission-request frame with a numeric ts as a frozen request', () => {
    const { received, socket } = makePermissionRequestClient();
    const request = samplePermissionRequest();

    socket.message(permissionRequestFrame());

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(request);
    expect(typeof received[0]!.ts).toBe('number');
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it('drops a permission-request frame with a missing ts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makePermissionRequestClient();

    const frame = JSON.parse(permissionRequestFrame()) as Record<string, unknown>;
    delete frame.ts;

    expect(() => socket.message(JSON.stringify(frame))).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('drops a permission-request frame with a non-number ts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makePermissionRequestClient();

    expect(() => socket.message(permissionRequestFrame({ ts: 'not-a-number' }))).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('drops a permission-request frame with a non-finite ts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makePermissionRequestClient();

    expect(() => socket.message(permissionRequestFrame({ ts: Number.POSITIVE_INFINITY }))).not.toThrow();
    expect(() => socket.message(permissionRequestFrame({ ts: Number.NaN }))).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

/** A well-formed hook-bus-liveness frame body. */
function sampleHookBusLiveness(): HookBusLiveness {
  return { connected: true, lastReceivedAt: 1700000000000 };
}

function hookBusLivenessFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'hook-bus-liveness', ...sampleHookBusLiveness(), ...overrides });
}

describe('ws-client hook-bus-liveness frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeHookBusLivenessClient() {
    const received: HookBusLiveness[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onHookBusLiveness((state) => received.push(state));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid hook-bus-liveness frame with connected and lastReceivedAt', () => {
    const { received, socket } = makeHookBusLivenessClient();

    socket.message(hookBusLivenessFrame());

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ connected: true, lastReceivedAt: 1700000000000 });
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it('round-trips a disconnected snapshot with a null lastReceivedAt', () => {
    const { received, socket } = makeHookBusLivenessClient();

    socket.message(hookBusLivenessFrame({ connected: false, lastReceivedAt: null }));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ connected: false, lastReceivedAt: null });
  });

  it('drops malformed hook-bus-liveness frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeHookBusLivenessClient();

    expect(() => socket.message(hookBusLivenessFrame({ connected: 'yes' }))).not.toThrow();
    expect(() => socket.message(hookBusLivenessFrame({ lastReceivedAt: 'nope' }))).not.toThrow();
    expect(() => socket.message(JSON.stringify({ type: 'hook-bus-liveness', lastReceivedAt: 1 }))).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

/** A well-formed cost-usage frame body. */
function sampleCostUsage(): CostUsage {
  return {
    costTodayUsd: 12.34,
    inputTokensToday: 1000,
    outputTokensToday: 500,
    sinceEpochMs: 1700000000000,
  };
}

function costUsageFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'cost-usage', ...sampleCostUsage(), ...overrides });
}

describe('ws-client cost-usage frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCostUsageClient() {
    const received: CostUsage[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const off = client.onCostUsage((usage) => received.push(usage));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, off, socket };
  }

  it('delivers a valid cost-usage frame to subscribers', () => {
    const { received, socket } = makeCostUsageClient();

    socket.message(costUsageFrame());

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(sampleCostUsage());
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it('drops malformed cost-usage frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeCostUsageClient();

    expect(() => socket.message(costUsageFrame({ costTodayUsd: 'nope' }))).not.toThrow();
    expect(() => socket.message(costUsageFrame({ inputTokensToday: NaN }))).not.toThrow();
    expect(() =>
      socket.message(JSON.stringify({ type: 'cost-usage', costTodayUsd: 1 })),
    ).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

function sampleEvidenceData(): EvidenceData {
  return {
    filesChanged: [{ path: 'src/foo.ts', status: 'modified' }],
    testResults: { summary: '12 passed' },
    prSummary: 'Adds the foo feature.',
    artifacts: [{ name: 'design.md', state: 'Final' }],
  };
}

function evidenceFrame(
  path: string,
  workItemId: string,
  evidence: unknown = sampleEvidenceData(),
): string {
  return JSON.stringify({ type: 'evidence', path, workItemId, evidence });
}

describe('ws-client evidence frames', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEvidenceClient() {
    const received: { path: string; workItemId: string; evidence: EvidenceData }[] = [];
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    client.onEvidence((path, workItemId, evidence) =>
      received.push({ path, workItemId, evidence }),
    );
    const socket = FakeSocket.instances[0]!;
    socket.open();
    return { client, received, socket };
  }

  it('delivers a valid evidence snapshot with the correct path, workItemId, and frozen evidence', () => {
    const { received, socket } = makeEvidenceClient();
    const evidence = sampleEvidenceData();

    socket.message(evidenceFrame('/abs/repo', 'WI-1', evidence));

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/abs/repo');
    expect(received[0]!.workItemId).toBe('WI-1');
    expect(received[0]!.evidence).toEqual(evidence);
    expect(Object.isFrozen(received[0]!.evidence)).toBe(true);
    expect(Object.isFrozen(received[0]!.evidence.filesChanged)).toBe(true);
    expect(Object.isFrozen(received[0]!.evidence.artifacts)).toBe(true);
  });

  it('drops malformed evidence frames without emitting to listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { received, socket } = makeEvidenceClient();

    // Missing evidence entirely.
    expect(() =>
      socket.message(JSON.stringify({ type: 'evidence', path: '/abs/repo', workItemId: 'WI-1' })),
    ).not.toThrow();
    // Bad artifact state.
    expect(() =>
      socket.message(
        evidenceFrame('/abs/repo', 'WI-1', {
          ...sampleEvidenceData(),
          artifacts: [{ name: 'design.md', state: 'Published' }],
        }),
      ),
    ).not.toThrow();
    // Non-string prSummary.
    expect(() =>
      socket.message(
        evidenceFrame('/abs/repo', 'WI-1', { ...sampleEvidenceData(), prSummary: 42 }),
      ),
    ).not.toThrow();
    // Missing testResults.summary.
    expect(() =>
      socket.message(
        evidenceFrame('/abs/repo', 'WI-1', {
          ...sampleEvidenceData(),
          testResults: {},
        }),
      ),
    ).not.toThrow();
    // workItemId missing.
    expect(() =>
      socket.message(
        JSON.stringify({ type: 'evidence', path: '/abs/repo', evidence: sampleEvidenceData() }),
      ),
    ).not.toThrow();

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('requestEvidence() sends an evidence-request frame once the socket is OPEN', () => {
    const client = createWsClient({
      url: 'ws://localhost/ws',
      createWebSocket: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.requestEvidence('/abs/repo', 'WI-1');

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'evidence-request', path: '/abs/repo', workItemId: 'WI-1' }),
    ]);
  });
});
