import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWsClient,
  type ConnectionStatus,
  type GitState,
  type Heartbeat,
  type RegistryCandidate,
  type RegistryProject,
  type TrackerState,
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
