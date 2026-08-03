// Integration test (THE GATE) — team-room transcript over the live WS transport.
//
// Boots the REAL server in-process (createServer({port:0,…})) with an INJECTED FAKE
// `query` engine (never live Claude), pins a project, opens real `ws` clients, spawns
// sessions, and asserts the observable transcript contract (story team-room-transcript):
//   AC1 — a connected client receives live `session-transcript` frames carrying an
//         assistant-text event (matching text) plus tool-use and tool-result events.
//   AC2 — a result-kind event carries inputTokens/outputTokens/durationMs/numTurns/
//         totalCostUsd/isError.
//   AC3 — a LATE-joining client B requests `session-transcript-request {sessionId}`
//         while the session is live and receives the buffered backfill on its own
//         socket; client A gets no duplicate backfill.
//   AC4 — no transcript persistence: the sqlite DB has no transcript table and the
//         `sessions` schema is unchanged; after session end the transcript is no
//         longer served (manager returns [] and a WS backfill request yields nothing).
//   AC5 — a garbage mid-stream message never flips the session to `errored` (it ends
//         `ended`); a concurrently-running normal sibling stays `running`.
//
// The fake engine keys its behavior off the role: 'reviewer' yields garbage messages
// mid-stream (AC5); every other role yields a clean scripted stream. Each fake session
// holds OPEN (gated on a manual promise) after its content messages, then yields its
// `result` message and completes when released (or interrupted at teardown).
// Isolation: per-test tmp DB + real tmp project dirs (projectRoots=[tmpdir()]);
// afterEach stops the server + removes DB sidecars and fixture dirs. NO live Claude.

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import type {
  EngineMessage,
  EngineSession,
  QueryFn,
  SpawnParams,
} from '../../src/session/session-engine.js';

// ---------------------------------------------------------------------------
// Frame shapes observed by the in-test client (loose mirrors of the wire types).
// ---------------------------------------------------------------------------

type AnyFrame = Record<string, unknown> & { readonly type: string };

interface SessionStateFrame extends AnyFrame {
  readonly type: 'session-state';
  readonly path: string;
  readonly session: {
    readonly id: string;
    readonly projectPath: string;
    readonly role: string;
    readonly status: string;
    readonly sdkSessionId: string | null;
  };
}

interface TranscriptEventWire {
  readonly kind: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly [key: string]: unknown;
}

interface TranscriptFrame extends AnyFrame {
  readonly type: 'session-transcript';
  readonly path: string;
  readonly sessionId: string;
  readonly events: readonly TranscriptEventWire[];
}

function isAnyFrame(value: unknown): value is AnyFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['type'] === 'string'
  );
}

function isSessionStateFrame(frame: AnyFrame): frame is SessionStateFrame {
  return (
    frame.type === 'session-state' &&
    typeof frame['path'] === 'string' &&
    typeof frame['session'] === 'object' &&
    frame['session'] !== null
  );
}

function isTranscriptFrame(frame: AnyFrame): frame is TranscriptFrame {
  return (
    frame.type === 'session-transcript' &&
    typeof frame['path'] === 'string' &&
    typeof frame['sessionId'] === 'string' &&
    Array.isArray(frame['events'])
  );
}

// ---------------------------------------------------------------------------
// Fake engine — scripted, role-keyed, holds open until released/interrupted.
// ---------------------------------------------------------------------------

const ASSISTANT_TEXT = 'Reading the plan before touching any code.';
const TOOL_USE_ID = 'toolu_01_read_plan';
const TOOL_NAME = 'Read';
const TOOL_RESULT_CONTENT = 'plan.md: Task 5 — the e2e gate.';

const RESULT_METRICS = {
  duration_ms: 1234,
  num_turns: 3,
  total_cost_usd: 0.0421,
  usage: { input_tokens: 512, output_tokens: 256 },
  is_error: false,
} as const;

/** The clean scripted content stream: init → assistant(text+tool_use) → user(tool_result). */
function normalContentMessages(sdkId: string): EngineMessage[] {
  return [
    { type: 'system', subtype: 'init', session_id: sdkId },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: ASSISTANT_TEXT },
          { type: 'tool_use', id: TOOL_USE_ID, name: TOOL_NAME, input: { file_path: '/tmp/plan.md' } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_ID,
            content: TOOL_RESULT_CONTENT,
            is_error: false,
          },
        ],
      },
    },
  ];
}

/** The garbage variant (AC5): the clean stream with malformed/unknown messages mixed in. */
function garbageContentMessages(sdkId: string): EngineMessage[] {
  const clean = normalContentMessages(sdkId);
  const garbage: EngineMessage[] = [
    // Unknown message type — the normalizer must ignore it.
    { type: 'flux-capacitor' },
    // Malformed assistant message — content is not a block array.
    { type: 'assistant', message: { content: 'not-an-array' } } as EngineMessage,
    // Malformed user message — inner message is null.
    { type: 'user', message: null } as EngineMessage,
  ];
  // Interleave: init, garbage, assistant, garbage, user, garbage.
  const first = clean[0] as EngineMessage;
  const second = clean[1] as EngineMessage;
  const third = clean[2] as EngineMessage;
  const g0 = garbage[0] as EngineMessage;
  const g1 = garbage[1] as EngineMessage;
  const g2 = garbage[2] as EngineMessage;
  return [first, g0, second, g1, third, g2];
}

interface FakeSpawn {
  readonly params: SpawnParams;
  /** Release the hold gate: the session yields its `result` message and completes. */
  readonly release: () => void;
}

/**
 * A scripted session: yields its content messages, then holds OPEN on a manual
 * promise (so siblings can be asserted while it is still `running`), then yields
 * the `result` message and completes. `interrupt()` also releases the gate so
 * server teardown (stopAll) always completes.
 */
function makeScriptedSession(content: readonly EngineMessage[]): {
  engine: EngineSession;
  release: () => void;
} {
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  async function* gen(): AsyncGenerator<EngineMessage> {
    for (const message of content) yield message;
    await gate; // stay live until the test (or teardown) releases the session
    yield { type: 'result', ...RESULT_METRICS };
  }

  const engine = Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => {
      releaseGate();
      return undefined;
    },
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    onQuestionRequest: (): void => {},
    answerQuestion: (): void => {},
    end: (): void => releaseGate(),
  });
  return { engine, release: releaseGate };
}

function makeFakeEngine(): { query: QueryFn; spawns: FakeSpawn[] } {
  const spawns: FakeSpawn[] = [];
  let counter = 0;
  const query: QueryFn = (params) => {
    counter += 1;
    const sdkId = `sdk-${counter}`;
    const content =
      params.role === 'reviewer' ? garbageContentMessages(sdkId) : normalContentMessages(sdkId);
    const { engine, release } = makeScriptedSession(content);
    spawns.push({ params, release });
    return engine;
  };
  return { query, spawns };
}

// ---------------------------------------------------------------------------
// In-test WS client — collects every typed frame; generic predicate waiter.
// ---------------------------------------------------------------------------

interface Waiter {
  readonly predicate: (frame: AnyFrame) => boolean;
  readonly resolve: (frame: AnyFrame) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForFrame: (
    predicate: (frame: AnyFrame) => boolean,
    timeoutMs: number,
    label: string,
  ) => Promise<AnyFrame>;
  readonly transcriptFrames: (sessionId: string) => TranscriptFrame[];
  readonly sessionStateFrames: () => SessionStateFrame[];
  readonly close: () => void;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let waiters: Waiter[] = [];
    const seen: AnyFrame[] = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    socket.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!opened) {
        clearTimeout(openTimer);
        reject(error);
        return;
      }
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });

    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isAnyFrame(parsed)) return;
      seen.push(parsed);
      const stillWaiting: Waiter[] = [];
      for (const waiter of waiters) {
        if (waiter.predicate(parsed)) {
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        } else {
          stillWaiting.push(waiter);
        }
      }
      waiters = stillWaiting;
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send: (message) => socket.send(JSON.stringify(message)),
        waitForFrame: (predicate, timeoutMs, label) =>
          new Promise<AnyFrame>((res, rej) => {
            const existing = seen.find(predicate);
            if (existing) {
              res(existing);
              return;
            }
            const timer = setTimeout(() => {
              waiters = waiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
            }, timeoutMs);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        transcriptFrames: (sessionId) =>
          seen.filter(isTranscriptFrame).filter((f) => f.sessionId === sessionId),
        sessionStateFrames: () => seen.filter(isSessionStateFrame),
        close: () => {
          socket.removeAllListeners();
          socket.close();
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Predicate + assertion helpers.
// ---------------------------------------------------------------------------

function sessionRunning(role: string): (frame: AnyFrame) => boolean {
  return (f) =>
    isSessionStateFrame(f) && f.session.role === role && f.session.status === 'running';
}

function sessionEnded(id: string): (frame: AnyFrame) => boolean {
  return (f) => isSessionStateFrame(f) && f.session.id === id && f.session.status === 'ended';
}

function transcriptWithKind(sessionId: string, kind: string): (frame: AnyFrame) => boolean {
  return (f) =>
    isTranscriptFrame(f) && f.sessionId === sessionId && f.events.some((e) => e.kind === kind);
}

/** All transcript events a client has received for one session, flattened in order. */
function allEvents(client: TestClient, sessionId: string): TranscriptEventWire[] {
  return client.transcriptFrames(sessionId).flatMap((f) => [...f.events]);
}

// ---------------------------------------------------------------------------
// Server + fixture lifecycle (mirrors session-manager.test.ts).
// ---------------------------------------------------------------------------

const activeClients: TestClient[] = [];
const activeStops: Array<() => Promise<void>> = [];
const tmpDbPaths: string[] = [];
const tmpDirs: string[] = [];

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-transcript-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

// A REAL project dir under tmpdir — the spawn containment guard requires the cwd to
// realpath-resolve within a configured project root (projectRoots = [tmpdir()]).
function makeProjectDir(): string {
  const path = join(tmpdir(), `devos-proj-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  tmpDirs.push(path);
  return path;
}

interface RunningServer {
  readonly instance: import('../../src/index.js').DevOsServer;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function startServer(dbPath: string, query: QueryFn): Promise<RunningServer> {
  const instance = createServer({ port: 0, dbPath, projectRoots: [tmpdir()], query });
  const address = (await instance.start()) as AddressInfo;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await instance.stop();
  };
  activeStops.push(stop);
  return { instance, url: `ws://127.0.0.1:${address.port}${WS_PATH}`, stop };
}

async function connect(url: string): Promise<TestClient> {
  const client = await openClient(url);
  activeClients.push(client);
  return client;
}

/** Spawn one session and wait for its `running` session-state frame. */
async function spawnSession(
  client: TestClient,
  project: string,
  role: string,
): Promise<string> {
  const framePromise = client.waitForFrame(sessionRunning(role), 5000, `${role} running`);
  client.send({ type: 'session-spawn', path: project, role });
  const frame = (await framePromise) as SessionStateFrame;
  return frame.session.id;
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) client.close();
  for (const stop of activeStops.splice(0)) await stop().catch(() => undefined);
  for (const path of tmpDbPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

describe('team-room transcript over the live WS transport', () => {
  it('AC1+AC2 — a connected client receives live assistant-text/tool-use/tool-result events and result metrics', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const sessionId = await spawnSession(client, project, 'builder');

    // AC1 — the live stream delivers the content events (tool-result is the last
    // content message, so waiting for it guarantees the earlier ones arrived too).
    await client.waitForFrame(transcriptWithKind(sessionId, 'tool-result'), 5000, 'tool-result event');

    const contentEvents = allEvents(client, sessionId);
    const text = contentEvents.find((e) => e.kind === 'assistant-text');
    expect(text?.['text']).toBe(ASSISTANT_TEXT);

    const toolUse = contentEvents.find((e) => e.kind === 'tool-use');
    expect(toolUse?.['toolName']).toBe(TOOL_NAME);
    expect(toolUse?.['toolUseId']).toBe(TOOL_USE_ID);
    expect(String(toolUse?.['toolInput'])).toContain('/tmp/plan.md');

    const toolResult = contentEvents.find((e) => e.kind === 'tool-result');
    expect(toolResult?.['toolUseId']).toBe(TOOL_USE_ID);
    expect(String(toolResult?.['content'])).toContain(TOOL_RESULT_CONTENT);
    expect(toolResult?.['isError']).toBe(false);

    // Release the gate: the fake yields its result message and completes.
    engine.spawns[0]?.release();
    await client.waitForFrame(transcriptWithKind(sessionId, 'result'), 5000, 'result event');

    // AC2 — the result-kind event carries the full metrics payload.
    const result = allEvents(client, sessionId).find((e) => e.kind === 'result');
    expect(result).toMatchObject({
      kind: 'result',
      durationMs: RESULT_METRICS.duration_ms,
      numTurns: RESULT_METRICS.num_turns,
      totalCostUsd: RESULT_METRICS.total_cost_usd,
      inputTokens: RESULT_METRICS.usage.input_tokens,
      outputTokens: RESULT_METRICS.usage.output_tokens,
      isError: false,
    });

    // Every event is stamped with the session id and a strictly-increasing seq.
    const events = allEvents(client, sessionId);
    expect(events.every((e) => e.sessionId === sessionId)).toBe(true);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(events.map((e) => e.kind)).toEqual([
      'init',
      'assistant-text',
      'tool-use',
      'tool-result',
      'result',
    ]);

    await client.waitForFrame(sessionEnded(sessionId), 5000, 'session ended');
  }, 15000);

  it('AC3 — a late-joining client gets the buffered backfill on its own socket; no duplicate on client A', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    // Client A watches the whole live stream.
    const clientA = await connect(server.url);
    const sessionId = await spawnSession(clientA, project, 'builder');
    await clientA.waitForFrame(transcriptWithKind(sessionId, 'tool-result'), 5000, 'tool-result on A');

    // Client B joins LATE — after the content events already flowed — and requests
    // the backfill for the still-live session.
    const clientB = await connect(server.url);
    expect(clientB.transcriptFrames(sessionId)).toHaveLength(0); // B saw none of the live events
    const backfillPromise = clientB.waitForFrame(
      transcriptWithKind(sessionId, 'tool-result'),
      5000,
      'backfill on B',
    );
    clientB.send({ type: 'session-transcript-request', sessionId });
    const backfill = (await backfillPromise) as TranscriptFrame;

    // The backfill carries the full buffered transcript so far, ordered by seq.
    expect(backfill.path).toBe(project);
    expect(backfill.events.map((e) => e.kind)).toEqual([
      'init',
      'assistant-text',
      'tool-use',
      'tool-result',
    ]);
    expect(backfill.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);

    // Ordering fence: release the session and wait for the result broadcast on A.
    // Any (wrong) duplicate backfill to A would have been sent BEFORE this frame,
    // so once it arrives we can assert A's history deterministically: A must have
    // received the seq-0 init event exactly once (live), never again as backfill.
    engine.spawns[0]?.release();
    await clientA.waitForFrame(transcriptWithKind(sessionId, 'result'), 5000, 'result on A');
    const seqZeroFramesOnA = clientA
      .transcriptFrames(sessionId)
      .filter((f) => f.events.some((e) => e.seq === 0));
    expect(seqZeroFramesOnA).toHaveLength(1);

    // B (still connected) also received the live result broadcast — live push
    // continues for late joiners after their backfill.
    await clientB.waitForFrame(transcriptWithKind(sessionId, 'result'), 5000, 'result on B');
  }, 15000);

  it('AC4 — no transcript persistence: no transcript table, sessions schema unchanged, ended sessions serve nothing', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath, engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    const sessionId = await spawnSession(client, project, 'builder');
    await client.waitForFrame(transcriptWithKind(sessionId, 'tool-result'), 5000, 'tool-result event');

    // While live, the manager serves the buffered transcript.
    expect(server.instance.sessionManager.getTranscript(sessionId).length).toBeGreaterThan(0);

    // End the session and wait for the final state frame.
    engine.spawns[0]?.release();
    await client.waitForFrame(sessionEnded(sessionId), 5000, 'session ended');

    // The buffer died with the session — the manager serves nothing.
    expect(server.instance.sessionManager.getTranscript(sessionId)).toEqual([]);

    // A WS backfill request for the ended session is a silent no-op. Fence: the
    // transcript handler replies synchronously in message order, so by the time the
    // (async) git-state reply arrives, any transcript frame would already be here.
    const framesBefore = client.transcriptFrames(sessionId).length;
    client.send({ type: 'session-transcript-request', sessionId });
    client.send({ type: 'git-state', path: project });
    await client.waitForFrame((f) => f.type === 'git-state', 5000, 'git-state fence');
    expect(client.transcriptFrames(sessionId).length).toBe(framesBefore);

    // DB inspection (second read-only connection to the live tmp DB): no transcript
    // table anywhere, and the `sessions` schema is unchanged.
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(tables.some((name) => /transcript/i.test(name))).toBe(false);
      expect(tables).toEqual(
        expect.arrayContaining(['projects', 'sessions', 'cost_ledger', 'ui_state']),
      );

      const sessionColumns = (
        db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(sessionColumns).toEqual([
        'id',
        'project_path',
        'work_item_id',
        'sdk_session_id',
        'role',
        'status',
        'current_stage',
        'created_at',
      ]);

      // And no transcript content leaked into any persisted row of any table.
      for (const table of tables) {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Array<
          Record<string, unknown>
        >;
        const dump = JSON.stringify(rows);
        expect(dump).not.toContain(ASSISTANT_TEXT);
        expect(dump).not.toContain(TOOL_RESULT_CONTENT);
      }
    } finally {
      db.close();
    }
  }, 15000);

  it('AC5 — a garbage mid-stream message ends the session `ended` (not `errored`); the sibling stays running', async () => {
    const project = makeProjectDir();
    const engine = makeFakeEngine();
    const server = await startServer(makeTmpDbPath(), engine.query);
    server.instance.registry.pin(project);

    const client = await connect(server.url);
    // 'reviewer' yields garbage messages mid-stream; 'builder' is the clean sibling.
    const gnarlyId = await spawnSession(client, project, 'reviewer');
    const siblingId = await spawnSession(client, project, 'builder');

    // The garbage-laced stream still delivers its clean events.
    await client.waitForFrame(transcriptWithKind(gnarlyId, 'tool-result'), 5000, 'reviewer tool-result');

    // Release ONLY the reviewer session — the sibling stays gated (still running).
    const wardenSpawn = engine.spawns.find((s) => s.params.role === 'reviewer');
    wardenSpawn?.release();
    await client.waitForFrame(sessionEnded(gnarlyId), 5000, 'reviewer ended');

    // The affected session NEVER reported `errored` — garbage is skipped, not fatal.
    const gnarlyStatuses = client
      .sessionStateFrames()
      .filter((f) => f.session.id === gnarlyId)
      .map((f) => f.session.status);
    expect(gnarlyStatuses).not.toContain('errored');
    expect(gnarlyStatuses[gnarlyStatuses.length - 1]).toBe('ended');

    // Its transcript still ends with a clean result event (garbage yielded no events).
    const gnarlyEvents = allEvents(client, gnarlyId);
    expect(gnarlyEvents.map((e) => e.kind)).toEqual([
      'init',
      'assistant-text',
      'tool-use',
      'tool-result',
      'result',
    ]);

    // The concurrent sibling is untouched: still live and `running` until released.
    const live = server.instance.sessionManager.list();
    expect(live.some((s) => s.id === siblingId && s.status === 'running')).toBe(true);
    expect(live.some((s) => s.id === gnarlyId)).toBe(false);

    // Release the sibling and confirm it also ends cleanly (isolation both ways).
    const siblingSpawn = engine.spawns.find((s) => s.params.role === 'builder');
    siblingSpawn?.release();
    await client.waitForFrame(sessionEnded(siblingId), 5000, 'sibling ended');
  }, 15000);
});
