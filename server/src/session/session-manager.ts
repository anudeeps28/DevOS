// Session Manager — spawn and multiplex owned Agent-SDK sessions (SPEC §3, M2 core).
//
// Holds the in-memory map of LIVE sessions and starts one long-lived `query()`
// generator per spawn (via the injected `QueryFn` seam — real SDK by default, a
// deterministic fake in every test). Each session runs with cwd = project root and
// carries a role identity. The manager consumes each message stream in a DETACHED
// loop to derive status (running → ended/errored) and capture the sdk session id
// from `system/init`, persisting the durable anchor row through the SessionStore.
//
// ROBUSTNESS (AC4): one session's generator throwing/ending is caught inside the
// consume loop — it NEVER rejects `spawn`, crashes the process, or affects sibling
// sessions. Live in-memory state is authoritative for running/ended; the store row
// is the durable last-known anchor.

import { randomUUID } from 'node:crypto';
import type { TranscriptEvent } from '../ws-protocol.js';
import type { Role } from './roles.js';
import { defaultQuery, type EngineMessage, type EngineSession, type QueryFn } from './session-engine.js';
import { acquireSessionSlot, type ReleaseSlot } from './session-spawn-limit.js';
import type { SessionStore } from './session-store.js';
import { normalizeMessage } from './transcript-events.js';

export type SessionStatus = 'running' | 'ended' | 'errored';

/** An immutable snapshot of one owned session's live state. */
export interface SessionSnapshot {
  readonly id: string;
  readonly projectPath: string;
  readonly role: Role;
  readonly status: SessionStatus;
  readonly sdkSessionId: string | null;
}

/** Input to spawn one owned session. */
export interface SpawnInput {
  readonly projectPath: string;
  readonly role: Role;
  readonly workItemId?: string;
  /** Kickoff prompt; defaults to a minimal attach message (real work assignment is a later task). */
  readonly prompt?: string;
  /** The pipeline stage this spawn represents; written to `sessions.current_stage` by the Bridge. */
  readonly currentStage?: string;
}

export type StateListener = (snapshot: SessionSnapshot) => void;

/** Fired with each frozen batch of transcript events captured from a live session. */
export type TranscriptListener = (
  projectPath: string,
  sessionId: string,
  events: readonly TranscriptEvent[],
) => void;

export interface SessionManager {
  readonly spawn: (input: SpawnInput) => Promise<SessionSnapshot>;
  readonly list: () => SessionSnapshot[];
  readonly get: (id: string) => SessionSnapshot | null;
  /** Register a listener fired on every session state change. Returns an unsubscribe fn. */
  readonly onState: (listener: StateListener) => () => void;
  /** Register a listener fired on every transcript event batch. Returns an unsubscribe fn. */
  readonly onTranscript: (listener: TranscriptListener) => () => void;
  /** The live session's buffered transcript (frozen copy), or `[]` if absent/ended. */
  readonly getTranscript: (id: string) => readonly TranscriptEvent[];
  /** Interrupt every live session (guarded). Called on server shutdown. */
  readonly stopAll: () => Promise<void>;
}

export interface SessionManagerDeps {
  readonly store: SessionStore;
  /** The engine seam — defaults to the real SDK. Tests inject a fake. */
  readonly query?: QueryFn;
}

const DEFAULT_PROMPT = 'You are now attached to this project. Await further instructions.';

/** Bound on the per-session in-memory transcript ring buffer (oldest dropped). */
const MAX_TRANSCRIPT_EVENTS = 500;

/** A live session held in memory while its generator runs. */
interface LiveSession {
  readonly id: string;
  readonly projectPath: string;
  readonly role: Role;
  status: SessionStatus;
  sdkSessionId: string | null;
  /** Monotonic per-session transcript sequence counter. */
  seq: number;
  /** Bounded in-memory ring buffer — dies with the live session, never persisted (AC4). */
  readonly transcript: TranscriptEvent[];
  readonly engine: EngineSession;
}

function isInitMessage(message: EngineMessage): boolean {
  return message.type === 'system' && message.subtype === 'init';
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { store } = deps;
  const query: QueryFn = deps.query ?? defaultQuery;
  const live = new Map<string, LiveSession>();
  const listeners = new Set<StateListener>();
  const transcriptListeners = new Set<TranscriptListener>();
  // Track detached consume loops so stopAll can await their completion (so the final
  // 'ended'/'errored' status persists before the DB is closed on shutdown).
  const consuming = new Set<Promise<void>>();

  const snapshot = (s: LiveSession): SessionSnapshot =>
    Object.freeze<SessionSnapshot>({
      id: s.id,
      projectPath: s.projectPath,
      role: s.role,
      status: s.status,
      sdkSessionId: s.sdkSessionId,
    });

  const emit = (s: LiveSession): void => {
    const snap = snapshot(s);
    for (const listener of listeners) {
      try {
        listener(snap);
      } catch (err) {
        console.error('[session] state listener threw', err);
      }
    }
  };

  const emitTranscript = (s: LiveSession, events: readonly TranscriptEvent[]): void => {
    for (const listener of transcriptListeners) {
      try {
        listener(s.projectPath, s.id, events);
      } catch (err) {
        console.error('[session] transcript listener threw', err);
      }
    }
  };

  // Normalize one engine message into stamped transcript events, push them onto the
  // session's bounded ring buffer, and fan the frozen batch out to listeners.
  const captureTranscript = (s: LiveSession, message: EngineMessage): void => {
    const bodies = normalizeMessage(message);
    if (bodies.length === 0) return;
    const batch: TranscriptEvent[] = [];
    for (const body of bodies) {
      const event = Object.freeze<TranscriptEvent>({
        ...body,
        sessionId: s.id,
        seq: s.seq++,
        ts: Date.now(),
      });
      s.transcript.push(event);
      if (s.transcript.length > MAX_TRANSCRIPT_EVENTS) s.transcript.shift();
      batch.push(event);
    }
    emitTranscript(s, Object.freeze(batch));
  };

  const setStatus = (s: LiveSession, status: SessionStatus): void => {
    s.status = status;
    try {
      store.updateStatus(s.id, status, s.sdkSessionId ?? undefined);
    } catch (err) {
      console.error(`[session] failed to persist status for ${s.id}`, err);
    }
    emit(s);
  };

  // Detached stream consumer. Wrapped so a throwing/ending generator only affects
  // THIS session — never rejects spawn, crashes the gateway, or touches siblings.
  const consume = async (s: LiveSession, release: ReleaseSlot): Promise<void> => {
    try {
      for await (const message of s.engine) {
        // Transcript capture is guarded PER MESSAGE: a throw here is logged and
        // skipped — it must never rethrow or flip the session's status (AC5). No
        // SessionStore call anywhere on this path — transcripts are in-memory only.
        try {
          captureTranscript(s, message);
        } catch (err) {
          console.error(`[session] transcript capture for ${s.id} threw`, err);
        }
        if (isInitMessage(message) && typeof message.session_id === 'string') {
          s.sdkSessionId = message.session_id;
          try {
            store.updateStatus(s.id, 'running', message.session_id);
          } catch (err) {
            console.error(`[session] failed to persist sdk session id for ${s.id}`, err);
          }
          emit(s);
        }
      }
      setStatus(s, 'ended');
    } catch (err) {
      console.error(`[session] stream for ${s.id} errored`, err);
      setStatus(s, 'errored');
    } finally {
      live.delete(s.id);
      release();
    }
  };

  const spawn = async (input: SpawnInput): Promise<SessionSnapshot> => {
    const id = randomUUID();
    const { projectPath, role } = input;

    // Acquire a concurrency slot FIRST (may queue behind the rate-limit cap). A
    // rejection (queue full) means NOTHING is persisted — so a spawn flood can't grow
    // the sessions table without bound. Only a session that actually gets a slot and
    // starts is written to disk.
    const release: ReleaseSlot = await acquireSessionSlot();

    // Persist the durable anchor (status running) now that the session will start.
    try {
      store.insert({
        id,
        projectPath,
        role,
        status: 'running',
        ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
        ...(input.currentStage !== undefined ? { currentStage: input.currentStage } : {}),
      });
    } catch (err) {
      release();
      throw err;
    }

    // Start the engine. A synchronous failure here must release the slot.
    let engine: EngineSession;
    try {
      engine = query({ cwd: projectPath, role, prompt: input.prompt ?? DEFAULT_PROMPT });
    } catch (err) {
      release();
      store.updateStatus(id, 'errored');
      throw err;
    }

    const session: LiveSession = {
      id,
      projectPath,
      role,
      status: 'running',
      sdkSessionId: null,
      seq: 0,
      transcript: [],
      engine,
    };
    live.set(id, session);
    emit(session); // running

    // Detached — spawn returns immediately so many sessions multiplex concurrently.
    // Tracked in `consuming` so stopAll can await completion on shutdown.
    const loop = consume(session, release);
    consuming.add(loop);
    void loop.finally(() => consuming.delete(loop));

    return snapshot(session);
  };

  const list = (): SessionSnapshot[] => [...live.values()].map(snapshot);

  const get = (id: string): SessionSnapshot | null => {
    const s = live.get(id);
    return s === undefined ? null : snapshot(s);
  };

  const onState = (listener: StateListener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const onTranscript = (listener: TranscriptListener): (() => void) => {
    transcriptListeners.add(listener);
    return () => transcriptListeners.delete(listener);
  };

  const getTranscript = (id: string): readonly TranscriptEvent[] => {
    const s = live.get(id);
    return s === undefined ? [] : Object.freeze([...s.transcript]);
  };

  const stopAll = async (): Promise<void> => {
    const running = [...live.values()];
    // Interrupt each live generator (guarded) — this closes its input stream so the
    // consume loop finishes.
    await Promise.all(
      running.map(async (s) => {
        try {
          await s.engine.interrupt();
        } catch (err) {
          console.error(`[session] failed to interrupt ${s.id}`, err);
        }
      }),
    );
    // Then await the consume loops so their final 'ended'/'errored' status persists
    // BEFORE the caller closes the DB (avoids a "database is closed" shutdown race).
    await Promise.allSettled([...consuming]);
  };

  return Object.freeze<SessionManager>({ spawn, list, get, onState, onTranscript, getTranscript, stopAll });
}
