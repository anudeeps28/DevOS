// Unit tests for the WS gateway (server/src/ws-gateway.ts):
// 1. pruneFloodGuard — the pure bound on a per-socket flood-guard Map: drops
//    expired entries first, evicts oldest-inserted when still over cap, stays
//    bounded / no-op under the cap.
// 2. Transcript wiring — the gateway attached to a REAL http server with a FAKE
//    registry + session manager and real `ws` clients: onTranscript broadcast,
//    socket-targeted backfill, pinned-path fail-closed, per-session flood-guard.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { WS_PATH } from './config.js';
import type { Registry } from './registry/registry.js';
import type { Bridge } from './session/bridge.js';
import type {
  SessionManager,
  SessionSnapshot,
  TranscriptListener,
} from './session/session-manager.js';
import type { ProjectAnchor, TranscriptEvent } from './ws-protocol.js';
import { attachWsGateway, FLOOD_GUARD_MAX_KEYS, pruneFloodGuard, type WsGateway } from './ws-gateway.js';

const WINDOW_MS = 200;

/** Build a Map of `count` keys, each stamped at `now - ageMs`, in insertion order. */
function buildMap(count: number, now: number, ageMs: number, prefix = 'p'): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < count; i += 1) {
    map.set(`${prefix}-${i}`, now - ageMs);
  }
  return map;
}

describe('pruneFloodGuard', () => {
  it('is a no-op while the Map is under the cap', () => {
    const now = 1_000_000;
    const map = buildMap(FLOOD_GUARD_MAX_KEYS - 1, now, 0);
    const before = new Map(map);

    pruneFloodGuard(map, now, WINDOW_MS);

    expect(map.size).toBe(FLOOD_GUARD_MAX_KEYS - 1);
    expect([...map.keys()]).toEqual([...before.keys()]);
  });

  it('drops expired entries first when at the cap', () => {
    const now = 1_000_000;
    const map = new Map<string, number>();

    // Half expired (older than the window), inserted first.
    const expiredCount = FLOOD_GUARD_MAX_KEYS / 2;
    for (let i = 0; i < expiredCount; i += 1) {
      map.set(`expired-${i}`, now - WINDOW_MS - 1);
    }
    // Half still fresh, inserted after.
    const freshCount = FLOOD_GUARD_MAX_KEYS - expiredCount;
    for (let i = 0; i < freshCount; i += 1) {
      map.set(`fresh-${i}`, now);
    }
    expect(map.size).toBe(FLOOD_GUARD_MAX_KEYS);

    pruneFloodGuard(map, now, WINDOW_MS);

    // Only the fresh entries survive; dropping the expired ones brought it under cap,
    // so no fresh entry was evicted.
    expect(map.size).toBe(freshCount);
    for (let i = 0; i < freshCount; i += 1) {
      expect(map.has(`fresh-${i}`)).toBe(true);
    }
    for (let i = 0; i < expiredCount; i += 1) {
      expect(map.has(`expired-${i}`)).toBe(false);
    }
  });

  it('evicts oldest-inserted entries when still over cap after expiry sweep', () => {
    const now = 1_000_000;
    // All fresh (none expired) and OVER the cap, so the expiry sweep frees nothing
    // and the loop must evict oldest-inserted until under the cap.
    const over = FLOOD_GUARD_MAX_KEYS + 5;
    const map = buildMap(over, now, 0);

    pruneFloodGuard(map, now, WINDOW_MS);

    // Bounded strictly under the cap.
    expect(map.size).toBe(FLOOD_GUARD_MAX_KEYS - 1);

    // The oldest-inserted keys were the ones evicted; the newest all survive.
    const evictedCount = over - (FLOOD_GUARD_MAX_KEYS - 1);
    for (let i = 0; i < evictedCount; i += 1) {
      expect(map.has(`p-${i}`)).toBe(false);
    }
    expect(map.has(`p-${over - 1}`)).toBe(true);
  });

  it('keeps the Map bounded under the cap regardless of input size', () => {
    const now = 1_000_000;
    const map = buildMap(FLOOD_GUARD_MAX_KEYS * 3, now, 0);

    pruneFloodGuard(map, now, WINDOW_MS);

    expect(map.size).toBeLessThan(FLOOD_GUARD_MAX_KEYS);
  });
});

// ---------------------------------------------------------------------------
// Transcript wiring — real http server + real ws clients, fake registry/manager.
// ---------------------------------------------------------------------------

/** A pinned-project anchor for the fake registry. */
function anchor(path: string): ProjectAnchor {
  return Object.freeze({ path, displayName: null, pinned: true, uiPrefs: null, createdAt: 0 });
}

/** A live-session snapshot for the fake manager. */
function liveSnapshot(id: string, projectPath: string): SessionSnapshot {
  return Object.freeze({ id, projectPath, role: 'navigator' as const, status: 'running' as const, sdkSessionId: null });
}

/** A minimal assistant-text transcript event fixture. */
function textEvent(sessionId: string, seq: number): TranscriptEvent {
  return Object.freeze({ kind: 'assistant-text' as const, text: `event-${seq}`, sessionId, seq, ts: 1_000 + seq });
}

interface TranscriptFrame {
  readonly type: 'session-transcript';
  readonly path: string;
  readonly sessionId: string;
  readonly events: readonly TranscriptEvent[];
}

interface HarnessOptions {
  readonly pinnedPaths?: readonly string[];
  readonly sessions?: Readonly<Record<string, SessionSnapshot>>;
  readonly transcripts?: Readonly<Record<string, readonly TranscriptEvent[]>>;
}

interface GatewayHarness {
  readonly url: string;
  /** Fire the manager's transcript channel as if a live session emitted a batch. */
  readonly fireTranscript: (
    path: string,
    sessionId: string,
    events: readonly TranscriptEvent[],
  ) => void;
  readonly close: () => Promise<void>;
}

interface TestClient {
  readonly send: (message: unknown) => void;
  /** Every `session-transcript` frame seen so far (other frame types are ignored). */
  readonly transcriptFrames: () => readonly TranscriptFrame[];
  /** Resolve once at least `count` transcript frames arrived; reject on timeout. */
  readonly waitForTranscriptCount: (count: number, timeoutMs?: number) => Promise<void>;
  readonly close: () => void;
}

const openHarnesses: GatewayHarness[] = [];
const openClients: TestClient[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    client.close();
  }
  for (const harness of openHarnesses.splice(0)) {
    await harness.close();
  }
});

/** Boot the gateway on a real loopback http server with fake registry + manager. */
async function startGateway(options: HarnessOptions = {}): Promise<GatewayHarness> {
  const pinnedPaths = options.pinnedPaths ?? [];
  const sessions = options.sessions ?? {};
  const transcripts = options.transcripts ?? {};
  const transcriptListeners = new Set<TranscriptListener>();

  const registry: Registry = Object.freeze({
    listProjects: () => pinnedPaths.map(anchor),
    pin: () => {
      throw new Error('pin not used in gateway transcript tests');
    },
    unpin: () => {
      throw new Error('unpin not used in gateway transcript tests');
    },
    setPrefs: () => {
      throw new Error('setPrefs not used in gateway transcript tests');
    },
  });

  const sessionManager: SessionManager = Object.freeze({
    spawn: () => Promise.reject(new Error('spawn not used in gateway transcript tests')),
    list: () => Object.values(sessions),
    get: (id: string) => sessions[id] ?? null,
    onState: () => () => {},
    onTranscript: (listener: TranscriptListener) => {
      transcriptListeners.add(listener);
      return () => {
        transcriptListeners.delete(listener);
      };
    },
    getTranscript: (id: string) => transcripts[id] ?? [],
    stopAll: () => Promise.resolve(),
  });

  const bridge: Bridge = Object.freeze({
    start: () => {},
    approveGate: () => {},
    interrupt: () => {},
    onState: () => () => {},
    getState: () => null,
    getInbox: () => [],
  });

  const server: Server = createServer();
  const gateway: WsGateway = attachWsGateway(server, {
    intervalMs: 60_000, // keep heartbeat noise out of short-lived tests
    registry,
    sessionManager,
    bridge,
    projectRoots: [],
    authToken: '',
    requireToken: false,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  const harness: GatewayHarness = Object.freeze({
    url: `ws://127.0.0.1:${port}${WS_PATH}`,
    fireTranscript: (path: string, sessionId: string, events: readonly TranscriptEvent[]) => {
      for (const listener of transcriptListeners) {
        listener(path, sessionId, events);
      }
    },
    close: async () => {
      await gateway.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  });
  openHarnesses.push(harness);
  return harness;
}

/** Open a real ws client and collect its `session-transcript` frames. */
function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const frames: TranscriptFrame[] = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    socket.on('error', (err) => {
      if (!opened) {
        clearTimeout(openTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === 'session-transcript'
      ) {
        frames.push(parsed as TranscriptFrame);
      }
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      const client: TestClient = Object.freeze({
        send: (message: unknown) => {
          socket.send(JSON.stringify(message));
        },
        transcriptFrames: () => [...frames],
        waitForTranscriptCount: (count: number, timeoutMs = 3000) =>
          new Promise<void>((resolveWait, rejectWait) => {
            const deadline = Date.now() + timeoutMs;
            const poll = (): void => {
              if (frames.length >= count) {
                resolveWait();
                return;
              }
              if (Date.now() >= deadline) {
                rejectWait(
                  new Error(
                    `Timed out waiting for ${count} transcript frame(s); saw ${frames.length}`,
                  ),
                );
                return;
              }
              setTimeout(poll, 10);
            };
            poll();
          }),
        close: () => {
          socket.removeAllListeners();
          socket.close();
        },
      });
      openClients.push(client);
      resolve(client);
    });
  });
}

/** Bounded quiet period for negative assertions (no frame must arrive). */
function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const PROJECT_PATH = '/tmp/devos-transcript-project';
const SESSION_ID = 'session-1';

describe('ws-gateway transcript wiring', () => {
  it('broadcasts an onTranscript emission to all connected clients', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const clientA = await openClient(harness.url);
    const clientB = await openClient(harness.url);
    const events = [textEvent(SESSION_ID, 0), textEvent(SESSION_ID, 1)];

    harness.fireTranscript(PROJECT_PATH, SESSION_ID, events);

    await clientA.waitForTranscriptCount(1);
    await clientB.waitForTranscriptCount(1);
    for (const client of [clientA, clientB]) {
      const frame = client.transcriptFrames()[0];
      expect(frame).toEqual({
        type: 'session-transcript',
        path: PROJECT_PATH,
        sessionId: SESSION_ID,
        events,
      });
    }
  });

  it('broadcasts nothing for an onTranscript emission whose path is not pinned (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [] }); // path NOT pinned
    const clientA = await openClient(harness.url);
    const clientB = await openClient(harness.url);

    harness.fireTranscript(PROJECT_PATH, SESSION_ID, [textEvent(SESSION_ID, 0)]);

    await settle();
    expect(clientA.transcriptFrames()).toHaveLength(0);
    expect(clientB.transcriptFrames()).toHaveLength(0);
  });

  it('replies to a session-transcript-request on the requesting socket only, with the buffered events', async () => {
    const buffered = [textEvent(SESSION_ID, 0), textEvent(SESSION_ID, 1), textEvent(SESSION_ID, 2)];
    const harness = await startGateway({
      pinnedPaths: [PROJECT_PATH],
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
      transcripts: { [SESSION_ID]: buffered },
    });
    const requester = await openClient(harness.url);
    const bystander = await openClient(harness.url);

    requester.send({ type: 'session-transcript-request', sessionId: SESSION_ID });

    await requester.waitForTranscriptCount(1);
    expect(requester.transcriptFrames()[0]).toEqual({
      type: 'session-transcript',
      path: PROJECT_PATH,
      sessionId: SESSION_ID,
      events: buffered,
    });
    await settle();
    expect(bystander.transcriptFrames()).toHaveLength(0);
  });

  it('sends no frame for an unknown session', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const client = await openClient(harness.url);

    client.send({ type: 'session-transcript-request', sessionId: 'no-such-session' });

    await settle();
    expect(client.transcriptFrames()).toHaveLength(0);
  });

  it('sends no frame when the owning path is not pinned (fails closed)', async () => {
    const harness = await startGateway({
      pinnedPaths: [], // session exists, but its project is NOT pinned
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
      transcripts: { [SESSION_ID]: [textEvent(SESSION_ID, 0)] },
    });
    const client = await openClient(harness.url);

    client.send({ type: 'session-transcript-request', sessionId: SESSION_ID });

    await settle();
    expect(client.transcriptFrames()).toHaveLength(0);
  });

  it('throttles rapid repeats of the same sessionId on one socket', async () => {
    const harness = await startGateway({
      pinnedPaths: [PROJECT_PATH],
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
      transcripts: { [SESSION_ID]: [textEvent(SESSION_ID, 0)] },
    });
    const client = await openClient(harness.url);

    // Two back-to-back requests — well inside the 200ms flood-guard window.
    client.send({ type: 'session-transcript-request', sessionId: SESSION_ID });
    client.send({ type: 'session-transcript-request', sessionId: SESSION_ID });

    await client.waitForTranscriptCount(1);
    await settle();
    expect(client.transcriptFrames()).toHaveLength(1);
  });
});
