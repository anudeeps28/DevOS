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
import { createHookBus } from './hooks/hook-bus.js';
import type { Registry } from './registry/registry.js';
import type { Bridge } from './session/bridge.js';
import type { CostLedgerStore, CostUsageAggregate } from './session/cost-ledger-store.js';
import type {
  EnginePermissionRequest,
  PermissionDecision,
} from './session/session-engine.js';
import type {
  CostUsageListener,
  SessionManager,
  SessionSnapshot,
  StateListener,
  TranscriptListener,
} from './session/session-manager.js';
import type { SessionRow, SessionStore } from './session/session-store.js';
import type {
  ProjectAnchor,
  SessionPersona,
  TranscriptEvent,
  WorkItemSessionAnchor,
} from './ws-protocol.js';
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
  return Object.freeze({
    id,
    projectPath,
    role: 'builder' as const,
    status: 'running' as const,
    sdkSessionId: null,
    workItemId: null,
    rateLimited: false,
  });
}

/** A persisted session row fixture for the fake session store. */
function sessionRow(id: string, workItemId: string): SessionRow {
  return Object.freeze({
    id,
    projectPath: PROJECT_PATH,
    workItemId,
    sdkSessionId: null,
    role: 'builder',
    status: 'running',
    currentStage: 'coding',
    createdAt: 0,
  });
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

interface SessionStateFrame {
  readonly type: 'session-state';
  readonly path: string;
  readonly session: SessionSnapshot;
}

interface SessionPersonasFrame {
  readonly type: 'session-personas';
  readonly path: string;
  readonly personas: readonly SessionPersona[];
}

interface WorkItemSessionsFrame {
  readonly type: 'work-item-sessions';
  readonly path: string;
  readonly workItemId: string;
  readonly sessions: readonly WorkItemSessionAnchor[];
}

interface EvidenceFrame {
  readonly type: 'evidence';
  readonly path: string;
  readonly workItemId: string;
  readonly evidence: unknown;
}

interface HarnessOptions {
  readonly pinnedPaths?: readonly string[];
  readonly sessions?: Readonly<Record<string, SessionSnapshot>>;
  readonly transcripts?: Readonly<Record<string, readonly TranscriptEvent[]>>;
  readonly costUsage?: CostUsageAggregate;
  readonly sessionRowsByWorkItem?: Readonly<Record<string, readonly SessionRow[]>>;
}

interface CostUsageFrame {
  readonly type: 'cost-usage';
  readonly costTodayUsd: number;
  readonly inputTokensToday: number;
  readonly outputTokensToday: number;
  readonly sinceEpochMs: number;
}

interface GatewayHarness {
  readonly url: string;
  /** Fire the manager's transcript channel as if a live session emitted a batch. */
  readonly fireTranscript: (
    path: string,
    sessionId: string,
    events: readonly TranscriptEvent[],
  ) => void;
  /** Fire the manager's state channel as if a live session's state changed. */
  readonly fireState: (session: SessionSnapshot) => void;
  /** Fire the manager's cost-usage channel as if a `result` was just recorded. */
  readonly fireCostUsage: (usage: CostUsageAggregate) => void;
  /** Every `sendInput(sessionId, text)` the gateway forwarded to the manager. */
  readonly steerCalls: () => readonly { readonly sessionId: string; readonly text: string }[];
  /** Every `interrupt(sessionId)` the gateway forwarded to the manager. */
  readonly interruptCalls: () => readonly string[];
  /** Fire the manager's permission-request channel as if a live session raised one. */
  readonly firePermissionRequest: (
    path: string,
    sessionId: string,
    req: EnginePermissionRequest,
  ) => void;
  /** Every `resolvePermission(sessionId, requestId, decision)` the gateway forwarded. */
  readonly permissionCalls: () => readonly {
    readonly sessionId: string;
    readonly requestId: string;
    readonly decision: PermissionDecision;
  }[];
  /** Every `bridge.requestChanges(path, notes)` the gateway forwarded. */
  readonly requestChangesCalls: () => readonly { readonly path: string; readonly notes: string }[];
  /** Every `bridge.answerQuestion(path, answer)` the gateway forwarded. */
  readonly answerQuestionCalls: () => readonly { readonly path: string; readonly answer: string }[];
  /** Every `bridge.resolveEscalation(path, choice, notes?)` the gateway forwarded. */
  readonly resolveEscalationCalls: () => readonly {
    readonly path: string;
    readonly choice: string;
    readonly notes: string | undefined;
  }[];
  readonly close: () => Promise<void>;
}

interface TestClient {
  readonly send: (message: unknown) => void;
  /** Every `session-transcript` frame seen so far (other frame types are ignored). */
  readonly transcriptFrames: () => readonly TranscriptFrame[];
  /** Resolve once at least `count` transcript frames arrived; reject on timeout. */
  readonly waitForTranscriptCount: (count: number, timeoutMs?: number) => Promise<void>;
  /** Every `permission-request` frame seen so far. */
  readonly permissionRequestFrames: () => readonly Record<string, unknown>[];
  /** Every `session-state` frame seen so far. */
  readonly stateFrames: () => readonly SessionStateFrame[];
  /** Resolve once at least `count` session-state frames arrived; reject on timeout. */
  readonly waitForStateCount: (count: number, timeoutMs?: number) => Promise<void>;
  /** Every `session-personas` frame seen so far. */
  readonly personasFrames: () => readonly SessionPersonasFrame[];
  /** Resolve once at least `count` session-personas frames arrived; reject on timeout. */
  readonly waitForPersonasCount: (count: number, timeoutMs?: number) => Promise<void>;
  /** Every `work-item-sessions` frame seen so far. */
  readonly workItemSessionsFrames: () => readonly WorkItemSessionsFrame[];
  /** Resolve once at least `count` work-item-sessions frames arrived; reject on timeout. */
  readonly waitForWorkItemSessionsCount: (count: number, timeoutMs?: number) => Promise<void>;
  /** Every `evidence` frame seen so far. */
  readonly evidenceFrames: () => readonly EvidenceFrame[];
  /** Resolve once at least `count` evidence frames arrived; reject on timeout. */
  readonly waitForEvidenceCount: (count: number, timeoutMs?: number) => Promise<void>;
  /** Every `cost-usage` frame seen so far. */
  readonly costUsageFrames: () => readonly CostUsageFrame[];
  /** Resolve once at least `count` cost-usage frames arrived; reject on timeout. */
  readonly waitForCostUsageCount: (count: number, timeoutMs?: number) => Promise<void>;
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
  const costUsage: CostUsageAggregate =
    options.costUsage ??
    Object.freeze({ costTodayUsd: 0, inputTokensToday: 0, outputTokensToday: 0, sinceEpochMs: 0 });
  const sessionRowsByWorkItem = options.sessionRowsByWorkItem ?? {};
  const transcriptListeners = new Set<TranscriptListener>();
  const stateListeners = new Set<StateListener>();
  const costUsageListeners = new Set<CostUsageListener>();
  const permissionRequestListeners = new Set<
    (path: string, sessionId: string, req: EnginePermissionRequest) => void
  >();

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

  const steerCalls: { readonly sessionId: string; readonly text: string }[] = [];
  const interruptCalls: string[] = [];
  const permissionCalls: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly decision: PermissionDecision;
  }[] = [];

  const sessionManager: SessionManager = Object.freeze({
    spawn: () => Promise.reject(new Error('spawn not used in gateway transcript tests')),
    list: () => Object.values(sessions),
    get: (id: string) => sessions[id] ?? null,
    onState: (listener: StateListener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onTranscript: (listener: TranscriptListener) => {
      transcriptListeners.add(listener);
      return () => {
        transcriptListeners.delete(listener);
      };
    },
    onCostUsage: (listener: CostUsageListener) => {
      costUsageListeners.add(listener);
      return () => {
        costUsageListeners.delete(listener);
      };
    },
    getTranscript: (id: string) => transcripts[id] ?? [],
    onPermissionRequest: (
      listener: (path: string, sessionId: string, req: EnginePermissionRequest) => void,
    ) => {
      permissionRequestListeners.add(listener);
      return () => {
        permissionRequestListeners.delete(listener);
      };
    },
    resolvePermission: (id: string, requestId: string, decision: PermissionDecision) => {
      permissionCalls.push({ sessionId: id, requestId, decision });
    },
    onQuestionRequest: () => () => {},
    answerQuestion: () => {},
    sendInput: (id: string, text: string) => {
      steerCalls.push({ sessionId: id, text });
    },
    interrupt: (id: string) => {
      interruptCalls.push(id);
      return Promise.resolve();
    },
    onContextUsage: () => () => {},
    onContextConfigWarning: () => () => {},
    endAtBoundary: () => {},
    stopAll: () => Promise.resolve(),
  });

  const requestChangesCalls: { readonly path: string; readonly notes: string }[] = [];
  const answerQuestionCalls: { readonly path: string; readonly answer: string }[] = [];
  const resolveEscalationCalls: {
    readonly path: string;
    readonly choice: string;
    readonly notes: string | undefined;
  }[] = [];

  const bridge: Bridge = Object.freeze({
    start: () => {},
    approveGate: () => {},
    interrupt: () => {},
    requestChanges: (path: string, notes: string) => {
      requestChangesCalls.push({ path, notes });
    },
    answerQuestion: (path: string, answer: string) => {
      answerQuestionCalls.push({ path, answer });
    },
    resolveEscalation: (path: string, choice: 'let-debug-try' | 'give-guidance' | 'take-over', notes?: string) => {
      resolveEscalationCalls.push({ path, choice, notes });
    },
    onState: () => () => {},
    getState: () => null,
    getInbox: () => [],
    stopAll: () => {},
  });

  const costLedger: CostLedgerStore = Object.freeze({
    insert: () => {},
    costToday: () => costUsage,
  });

  const sessionStore: SessionStore = Object.freeze({
    insert: () => {
      throw new Error('insert not used in gateway transcript tests');
    },
    updateStatus: () => {
      throw new Error('updateStatus not used in gateway transcript tests');
    },
    list: () => {
      throw new Error('list not used in gateway transcript tests');
    },
    get: () => {
      throw new Error('get not used in gateway transcript tests');
    },
    listByWorkItem: (workItemId: string, projectPath: string) =>
      [...(sessionRowsByWorkItem[workItemId] ?? [])].filter((r) => r.projectPath === projectPath),
  });

  const server: Server = createServer();
  const gateway: WsGateway = attachWsGateway(server, {
    intervalMs: 60_000, // keep heartbeat noise out of short-lived tests
    registry,
    sessionManager,
    sessionStore,
    bridge,
    hookBus: createHookBus(),
    costLedger,
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
    fireState: (session: SessionSnapshot) => {
      for (const listener of stateListeners) {
        listener(session);
      }
    },
    fireCostUsage: (usage: CostUsageAggregate) => {
      for (const listener of costUsageListeners) {
        listener(usage);
      }
    },
    steerCalls: () => [...steerCalls],
    interruptCalls: () => [...interruptCalls],
    firePermissionRequest: (path: string, sessionId: string, req: EnginePermissionRequest) => {
      for (const listener of permissionRequestListeners) {
        listener(path, sessionId, req);
      }
    },
    permissionCalls: () => [...permissionCalls],
    requestChangesCalls: () => [...requestChangesCalls],
    answerQuestionCalls: () => [...answerQuestionCalls],
    resolveEscalationCalls: () => [...resolveEscalationCalls],
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
    const permissionFrames: Record<string, unknown>[] = [];
    const stateFrames: SessionStateFrame[] = [];
    const personasFrames: SessionPersonasFrame[] = [];
    const workItemSessionsFrames: WorkItemSessionsFrame[] = [];
    const evidenceFrames: EvidenceFrame[] = [];
    const costUsageFrames: CostUsageFrame[] = [];
    let opened = false;

    /** Poll until `getCount()` reaches `count`, or reject after `timeoutMs`. */
    function waitForCount(getCount: () => number, label: string, count: number, timeoutMs: number): Promise<void> {
      return new Promise<void>((resolveWait, rejectWait) => {
        const deadline = Date.now() + timeoutMs;
        const poll = (): void => {
          if (getCount() >= count) {
            resolveWait();
            return;
          }
          if (Date.now() >= deadline) {
            rejectWait(new Error(`Timed out waiting for ${count} ${label} frame(s); saw ${getCount()}`));
            return;
          }
          setTimeout(poll, 10);
        };
        poll();
      });
    }

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
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === 'permission-request'
      ) {
        permissionFrames.push(parsed as Record<string, unknown>);
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === 'session-state'
      ) {
        stateFrames.push(parsed as SessionStateFrame);
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === 'session-personas'
      ) {
        personasFrames.push(parsed as SessionPersonasFrame);
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === 'work-item-sessions'
      ) {
        workItemSessionsFrames.push(parsed as WorkItemSessionsFrame);
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === 'evidence'
      ) {
        evidenceFrames.push(parsed as EvidenceFrame);
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === 'cost-usage'
      ) {
        costUsageFrames.push(parsed as CostUsageFrame);
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
        permissionRequestFrames: () => [...permissionFrames],
        stateFrames: () => [...stateFrames],
        waitForStateCount: (count: number, timeoutMs = 3000) =>
          waitForCount(() => stateFrames.length, 'session-state', count, timeoutMs),
        personasFrames: () => [...personasFrames],
        waitForPersonasCount: (count: number, timeoutMs = 3000) =>
          waitForCount(() => personasFrames.length, 'session-personas', count, timeoutMs),
        workItemSessionsFrames: () => [...workItemSessionsFrames],
        waitForWorkItemSessionsCount: (count: number, timeoutMs = 3000) =>
          waitForCount(() => workItemSessionsFrames.length, 'work-item-sessions', count, timeoutMs),
        evidenceFrames: () => [...evidenceFrames],
        waitForEvidenceCount: (count: number, timeoutMs = 3000) =>
          waitForCount(() => evidenceFrames.length, 'evidence', count, timeoutMs),
        costUsageFrames: () => [...costUsageFrames],
        waitForCostUsageCount: (count: number, timeoutMs = 3000) =>
          waitForCount(() => costUsageFrames.length, 'cost-usage', count, timeoutMs),
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

describe('ws-gateway steer + interrupt routing', () => {
  it('routes a session-input for a pinned session to sendInput(sessionId, text)', async () => {
    const harness = await startGateway({
      pinnedPaths: [PROJECT_PATH],
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
    });
    const client = await openClient(harness.url);

    client.send({ type: 'session-input', sessionId: SESSION_ID, text: 'refactor the parser' });

    await settle();
    expect(harness.steerCalls()).toEqual([{ sessionId: SESSION_ID, text: 'refactor the parser' }]);
    expect(harness.interruptCalls()).toEqual([]);
  });

  it('routes a session-interrupt for a pinned session to interrupt(sessionId)', async () => {
    const harness = await startGateway({
      pinnedPaths: [PROJECT_PATH],
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
    });
    const client = await openClient(harness.url);

    client.send({ type: 'session-interrupt', sessionId: SESSION_ID });

    await settle();
    expect(harness.interruptCalls()).toEqual([SESSION_ID]);
    expect(harness.steerCalls()).toEqual([]);
  });

  it('is a no-op for an unknown session (fails closed) — steer and interrupt', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] }); // no live sessions
    const client = await openClient(harness.url);

    client.send({ type: 'session-input', sessionId: 'no-such-session', text: 'x' });
    client.send({ type: 'session-interrupt', sessionId: 'no-such-session' });

    await settle();
    expect(harness.steerCalls()).toEqual([]);
    expect(harness.interruptCalls()).toEqual([]);
  });

  it('is a no-op when the owning path is not pinned (fails closed) — steer and interrupt', async () => {
    const harness = await startGateway({
      pinnedPaths: [], // session exists, but its project is NOT pinned
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
    });
    const client = await openClient(harness.url);

    client.send({ type: 'session-input', sessionId: SESSION_ID, text: 'x' });
    client.send({ type: 'session-interrupt', sessionId: SESSION_ID });

    await settle();
    expect(harness.steerCalls()).toEqual([]);
    expect(harness.interruptCalls()).toEqual([]);
  });
});

describe('ws-gateway gate-request-changes routing', () => {
  it('routes a gate-request-changes for a pinned path to bridge.requestChanges(path, sanitizedNotes)', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const client = await openClient(harness.url);

    client.send({ type: 'gate-request-changes', path: PROJECT_PATH, notes: 'please fix the tests' });

    await settle();
    expect(harness.requestChangesCalls()).toEqual([
      { path: PROJECT_PATH, notes: 'please fix the tests' },
    ]);
  });

  it('is a no-op for an unpinned path (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [] }); // PROJECT_PATH is NOT pinned
    const client = await openClient(harness.url);

    client.send({ type: 'gate-request-changes', path: PROJECT_PATH, notes: 'please fix the tests' });

    await settle();
    expect(harness.requestChangesCalls()).toEqual([]);
  });
});

describe('ws-gateway question-answer routing', () => {
  it('routes a question-answer for a pinned path to bridge.answerQuestion(path, answer)', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const client = await openClient(harness.url);

    client.send({ type: 'question-answer', path: PROJECT_PATH, answer: 'yes, proceed' });

    await settle();
    expect(harness.answerQuestionCalls()).toEqual([{ path: PROJECT_PATH, answer: 'yes, proceed' }]);
  });

  it('is a no-op for an unpinned path (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [] }); // PROJECT_PATH is NOT pinned
    const client = await openClient(harness.url);

    client.send({ type: 'question-answer', path: PROJECT_PATH, answer: 'yes, proceed' });

    await settle();
    expect(harness.answerQuestionCalls()).toEqual([]);
  });
});

describe('ws-gateway escalation-choice routing', () => {
  it('routes an escalation-choice for a pinned path to bridge.resolveEscalation(path, choice, notes)', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const client = await openClient(harness.url);

    client.send({
      type: 'escalation-choice',
      path: PROJECT_PATH,
      choice: 'give-guidance',
      notes: 'try a different approach',
    });

    await settle();
    expect(harness.resolveEscalationCalls()).toEqual([
      { path: PROJECT_PATH, choice: 'give-guidance', notes: 'try a different approach' },
    ]);
  });

  it('is a no-op for an unpinned path (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [] }); // PROJECT_PATH is NOT pinned
    const client = await openClient(harness.url);

    client.send({ type: 'escalation-choice', path: PROJECT_PATH, choice: 'take-over' });

    await settle();
    expect(harness.resolveEscalationCalls()).toEqual([]);
  });
});

describe('ws-gateway permission routing', () => {
  const permReq: EnginePermissionRequest = {
    requestId: 'req-1',
    toolUseId: 'tu-1',
    toolName: 'Bash',
    title: 'run a command',
    input: '{"command":"ls"}',
    ts: 1_700_000_000_000,
  };

  it('routes a permission-decision for a pinned session to resolvePermission(id, requestId, decision)', async () => {
    const harness = await startGateway({
      pinnedPaths: [PROJECT_PATH],
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
    });
    const client = await openClient(harness.url);

    client.send({
      type: 'permission-decision',
      sessionId: SESSION_ID,
      requestId: 'req-1',
      decision: 'allow',
    });

    await settle();
    expect(harness.permissionCalls()).toEqual([
      { sessionId: SESSION_ID, requestId: 'req-1', decision: 'allow' },
    ]);
  });

  it('is a no-op for an unknown session (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] }); // no live sessions
    const client = await openClient(harness.url);

    client.send({
      type: 'permission-decision',
      sessionId: 'no-such-session',
      requestId: 'req-1',
      decision: 'deny',
    });

    await settle();
    expect(harness.permissionCalls()).toEqual([]);
  });

  it('is a no-op when the owning path is not pinned (fails closed)', async () => {
    const harness = await startGateway({
      pinnedPaths: [], // session exists, but its project is NOT pinned
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
    });
    const client = await openClient(harness.url);

    client.send({
      type: 'permission-decision',
      sessionId: SESSION_ID,
      requestId: 'req-1',
      decision: 'allow',
    });

    await settle();
    expect(harness.permissionCalls()).toEqual([]);
  });

  it('broadcasts a permission-request only for a pinned path', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const client = await openClient(harness.url);

    harness.firePermissionRequest(PROJECT_PATH, SESSION_ID, permReq);

    await settle();
    const frames = client.permissionRequestFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'permission-request',
      path: PROJECT_PATH,
      sessionId: SESSION_ID,
      requestId: 'req-1',
      toolName: 'Bash',
      input: '{"command":"ls"}',
      ts: permReq.ts,
    });
    expect(typeof frames[0]!.ts).toBe('number');
  });

  it('broadcasts nothing for a permission-request whose path is not pinned (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [] }); // path NOT pinned
    const client = await openClient(harness.url);

    harness.firePermissionRequest(PROJECT_PATH, SESSION_ID, permReq);

    await settle();
    expect(client.permissionRequestFrames()).toEqual([]);
  });

  it('routes a permission-decision with decision "allow-always" for a pinned session to resolvePermission(id, requestId, "allow-always")', async () => {
    const harness = await startGateway({
      pinnedPaths: [PROJECT_PATH],
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
    });
    const client = await openClient(harness.url);

    client.send({
      type: 'permission-decision',
      sessionId: SESSION_ID,
      requestId: 'req-1',
      decision: 'allow-always',
    });

    await settle();
    expect(harness.permissionCalls()).toEqual([
      { sessionId: SESSION_ID, requestId: 'req-1', decision: 'allow-always' },
    ]);
  });

  it('is a no-op for "allow-always" on an unknown/unpinned session (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [] }); // no live sessions, nothing pinned
    const client = await openClient(harness.url);

    client.send({
      type: 'permission-decision',
      sessionId: 'no-such-session',
      requestId: 'req-1',
      decision: 'allow-always',
    });

    await settle();
    expect(harness.permissionCalls()).toEqual([]);
  });
});

describe('ws-gateway session-state broadcast', () => {
  it('broadcasts a session-state change carrying workItemId and rateLimited', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const client = await openClient(harness.url);
    const session: SessionSnapshot = Object.freeze({
      id: SESSION_ID,
      projectPath: PROJECT_PATH,
      role: 'reviewer' as const,
      status: 'running' as const,
      sdkSessionId: null,
      workItemId: 'WI-1',
      rateLimited: true,
    });

    harness.fireState(session);

    await client.waitForStateCount(1);
    expect(client.stateFrames()[0]).toEqual({
      type: 'session-state',
      path: PROJECT_PATH,
      session,
    });
  });
});

describe('ws-gateway session-personas routing', () => {
  it('replies to a session-personas request on the requesting socket only', async () => {
    const harness = await startGateway({
      pinnedPaths: [PROJECT_PATH],
      sessions: { [SESSION_ID]: liveSnapshot(SESSION_ID, PROJECT_PATH) },
    });
    const requester = await openClient(harness.url);
    const bystander = await openClient(harness.url);

    requester.send({ type: 'session-personas', path: PROJECT_PATH });

    await requester.waitForPersonasCount(1);
    const frame = requester.personasFrames()[0];
    expect(frame).toMatchObject({ type: 'session-personas', path: PROJECT_PATH });
    expect(frame?.personas).toEqual([
      { sessionId: SESSION_ID, workItemId: null, role: 'builder', phase: null, persona: null },
    ]);
    await settle();
    expect(bystander.personasFrames()).toHaveLength(0);
  });

  it('sends no frame when the requested path is not pinned (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [] }); // path NOT pinned
    const client = await openClient(harness.url);

    client.send({ type: 'session-personas', path: PROJECT_PATH });

    await settle();
    expect(client.personasFrames()).toHaveLength(0);
  });
});

const WORK_ITEM_ID = 'WI-1';

describe('ws-gateway work-item-sessions routing', () => {
  it('replies with the persisted anchors for a pinned path', async () => {
    const row = sessionRow(SESSION_ID, WORK_ITEM_ID);
    const harness = await startGateway({
      pinnedPaths: [PROJECT_PATH],
      sessionRowsByWorkItem: { [WORK_ITEM_ID]: [row] },
    });
    const requester = await openClient(harness.url);
    const bystander = await openClient(harness.url);

    requester.send({ type: 'work-item-sessions-request', path: PROJECT_PATH, workItemId: WORK_ITEM_ID });

    await requester.waitForWorkItemSessionsCount(1);
    const frame = requester.workItemSessionsFrames()[0];
    expect(frame).toEqual({
      type: 'work-item-sessions',
      path: PROJECT_PATH,
      workItemId: WORK_ITEM_ID,
      sessions: [
        {
          id: row.id,
          role: row.role,
          status: row.status,
          sdkSessionId: row.sdkSessionId,
          currentStage: row.currentStage,
          createdAt: row.createdAt,
        },
      ],
    });
    await settle();
    expect(bystander.workItemSessionsFrames()).toHaveLength(0);
  });

  it('sends no frame when the requested path is not pinned (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [] }); // path NOT pinned
    const client = await openClient(harness.url);

    client.send({ type: 'work-item-sessions-request', path: PROJECT_PATH, workItemId: WORK_ITEM_ID });

    await settle();
    expect(client.workItemSessionsFrames()).toHaveLength(0);
  });
});

describe('ws-gateway evidence routing', () => {
  it('replies to an evidence-request on the requesting socket only', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const requester = await openClient(harness.url);
    const bystander = await openClient(harness.url);

    requester.send({ type: 'evidence-request', path: PROJECT_PATH, workItemId: WORK_ITEM_ID });

    await requester.waitForEvidenceCount(1);
    const frame = requester.evidenceFrames()[0];
    expect(frame).toMatchObject({ type: 'evidence', path: PROJECT_PATH, workItemId: WORK_ITEM_ID });
    await settle();
    expect(bystander.evidenceFrames()).toHaveLength(0);
  });

  it('sends no frame when the requested path is not pinned (fails closed)', async () => {
    const harness = await startGateway({ pinnedPaths: [] }); // path NOT pinned
    const client = await openClient(harness.url);

    client.send({ type: 'evidence-request', path: PROJECT_PATH, workItemId: WORK_ITEM_ID });

    await settle();
    expect(client.evidenceFrames()).toHaveLength(0);
  });

  it('throttles rapid repeats of the same (path, workItemId) on one socket', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const client = await openClient(harness.url);

    // Two back-to-back requests — well inside the flood-guard window.
    client.send({ type: 'evidence-request', path: PROJECT_PATH, workItemId: WORK_ITEM_ID });
    client.send({ type: 'evidence-request', path: PROJECT_PATH, workItemId: WORK_ITEM_ID });

    await client.waitForEvidenceCount(1);
    await settle();
    expect(client.evidenceFrames()).toHaveLength(1);
  });

  it('replies to distinct workItemIds — fan-out preserved', async () => {
    const harness = await startGateway({ pinnedPaths: [PROJECT_PATH] });
    const client = await openClient(harness.url);

    client.send({ type: 'evidence-request', path: PROJECT_PATH, workItemId: 'WI-1' });
    client.send({ type: 'evidence-request', path: PROJECT_PATH, workItemId: 'WI-2' });

    await client.waitForEvidenceCount(2);
    const workItemIds = client.evidenceFrames().map((f) => f.workItemId);
    expect(workItemIds.sort()).toEqual(['WI-1', 'WI-2']);
  });
});

describe('ws-gateway cost-usage', () => {
  it('sends an initial cost-usage snapshot from costLedger.costToday() on connect', async () => {
    const usage: CostUsageAggregate = Object.freeze({
      costTodayUsd: 4.56,
      inputTokensToday: 100,
      outputTokensToday: 200,
      sinceEpochMs: 12_345,
    });
    const harness = await startGateway({ costUsage: usage });
    const client = await openClient(harness.url);

    await client.waitForCostUsageCount(1);
    expect(client.costUsageFrames()[0]).toEqual({ type: 'cost-usage', ...usage });
  });

  it('broadcasts an onCostUsage emission to all connected clients', async () => {
    const harness = await startGateway();
    const clientA = await openClient(harness.url);
    const clientB = await openClient(harness.url);
    // Each already got the initial snapshot on connect.
    await clientA.waitForCostUsageCount(1);
    await clientB.waitForCostUsageCount(1);

    const usage: CostUsageAggregate = Object.freeze({
      costTodayUsd: 1.23,
      inputTokensToday: 10,
      outputTokensToday: 20,
      sinceEpochMs: 999,
    });
    harness.fireCostUsage(usage);

    await clientA.waitForCostUsageCount(2);
    await clientB.waitForCostUsageCount(2);
    expect(clientA.costUsageFrames()[1]).toEqual({ type: 'cost-usage', ...usage });
    expect(clientB.costUsageFrames()[1]).toEqual({ type: 'cost-usage', ...usage });
  });
});
