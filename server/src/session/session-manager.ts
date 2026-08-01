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
import type { TranscriptEvent, TranscriptEventBody } from '../ws-protocol.js';
import type { Role } from './roles.js';
import type { Effort } from './roster-reader.js';
import {
  defaultQuery,
  type EngineMessage,
  type EnginePermissionRequest,
  type EngineSession,
  type PermissionDecision,
  type QueryFn,
} from './session-engine.js';
import { acquireSessionSlot, type ReleaseSlot } from './session-spawn-limit.js';
import type { CostLedgerStore, CostUsageAggregate } from './cost-ledger-store.js';
import type { SessionStore } from './session-store.js';
import { MAX_TEXT_CHARS, normalizeMessage } from './transcript-events.js';

export type SessionStatus = 'running' | 'ended' | 'errored';

/** An immutable snapshot of one owned session's live state. */
export interface SessionSnapshot {
  readonly id: string;
  readonly projectPath: string;
  readonly role: Role;
  readonly status: SessionStatus;
  readonly sdkSessionId: string | null;
  readonly workItemId: string | null;
  readonly rateLimited: boolean;
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
  /** The roster-declared model id; defaults to DEFAULT_MODEL when absent (non-Bridge spawns). */
  readonly model?: string;
  /** The roster-declared effort level; defaults to DEFAULT_EFFORT when absent (non-Bridge spawns). */
  readonly effort?: Effort;
}

export type StateListener = (snapshot: SessionSnapshot) => void;

/** Fired with the latest cost/usage aggregate whenever a `result` message is recorded. */
export type CostUsageListener = (usage: CostUsageAggregate) => void;

/** Fired with each frozen batch of transcript events captured from a live session. */
export type TranscriptListener = (
  projectPath: string,
  sessionId: string,
  events: readonly TranscriptEvent[],
) => void;

/** Fired with each permission request raised by a live session, awaiting a decision. */
export type PermissionRequestListener = (
  projectPath: string,
  sessionId: string,
  req: EnginePermissionRequest,
) => void;

export interface SessionManager {
  readonly spawn: (input: SpawnInput) => Promise<SessionSnapshot>;
  readonly list: () => SessionSnapshot[];
  readonly get: (id: string) => SessionSnapshot | null;
  /** Register a listener fired on every session state change. Returns an unsubscribe fn. */
  readonly onState: (listener: StateListener) => () => void;
  /** Register a listener fired on every transcript event batch. Returns an unsubscribe fn. */
  readonly onTranscript: (listener: TranscriptListener) => () => void;
  /** Register a listener fired on every permission request. Returns an unsubscribe fn. */
  readonly onPermissionRequest: (listener: PermissionRequestListener) => () => void;
  /** Register a listener fired with the latest cost/usage aggregate. Returns an unsubscribe fn. */
  readonly onCostUsage: (listener: CostUsageListener) => () => void;
  /** The live session's buffered transcript (frozen copy), or `[]` if absent/ended. */
  readonly getTranscript: (id: string) => readonly TranscriptEvent[];
  /**
   * Steer a live session with mid-run user text: echo a `user-text` transcript event
   * (the SDK does not echo streaming-input) then push the text into the live input
   * stream. Guarded + per-session isolated; a no-op for an unknown/ended session.
   */
  readonly sendInput: (id: string, text: string) => void;
  /**
   * Interrupt a live session's CURRENT TURN without ending the session — the status
   * stays `running`. Guarded; a no-op for an unknown/ended session.
   */
  readonly interrupt: (id: string) => Promise<void>;
  /**
   * Resolve a pending permission request with the operator's decision, then record a
   * `permission` audit transcript event. Guarded + per-session isolated; a no-op for
   * an unknown/ended session.
   */
  readonly resolvePermission: (id: string, requestId: string, decision: PermissionDecision) => void;
  /** Interrupt every live session (guarded). Called on server shutdown. */
  readonly stopAll: () => Promise<void>;
}

export interface SessionManagerDeps {
  readonly store: SessionStore;
  /** The engine seam — defaults to the real SDK. Tests inject a fake. */
  readonly query?: QueryFn;
  /** The cost ledger — absent means cost recording is a no-op (non-Bridge callers/tests). */
  readonly costLedger?: CostLedgerStore;
}

const DEFAULT_PROMPT = 'You are now attached to this project. Await further instructions.';

// Fallback model/effort for a spawn with no roster context (e.g. a non-Bridge caller) —
// 'inherit' means the SDK's main/default model (SPEC's subscription-auth default).
const DEFAULT_MODEL = 'inherit';
const DEFAULT_EFFORT: Effort = 'medium';

/** Bound on the per-session in-memory transcript ring buffer (oldest dropped). */
const MAX_TRANSCRIPT_EVENTS = 500;

/** A live session held in memory while its generator runs. */
interface LiveSession {
  readonly id: string;
  readonly projectPath: string;
  readonly role: Role;
  readonly workItemId: string | null;
  status: SessionStatus;
  sdkSessionId: string | null;
  /** Monotonic per-session transcript sequence counter. */
  seq: number;
  /** Bounded in-memory ring buffer — dies with the live session, never persisted (AC4). */
  readonly transcript: TranscriptEvent[];
  readonly engine: EngineSession;
  /** requestId → toolName, populated as permission requests are raised (for the audit event). */
  readonly permissionToolNames: Map<string, string>;
}

function isInitMessage(message: EngineMessage): boolean {
  return message.type === 'system' && message.subtype === 'init';
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { store, costLedger } = deps;
  const query: QueryFn = deps.query ?? defaultQuery;
  const live = new Map<string, LiveSession>();
  const listeners = new Set<StateListener>();
  const transcriptListeners = new Set<TranscriptListener>();
  const permissionRequestListeners = new Set<PermissionRequestListener>();
  const costUsageListeners = new Set<CostUsageListener>();
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
      workItemId: s.workItemId,
      // Always false today — the deferred plan-limit detector is the future writer.
      rateLimited: false,
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

  const emitPermission = (s: LiveSession, req: EnginePermissionRequest): void => {
    for (const listener of permissionRequestListeners) {
      try {
        listener(s.projectPath, s.id, req);
      } catch (err) {
        console.error('[session] permission request listener threw', err);
      }
    }
  };

  const emitCostUsage = (usage: CostUsageAggregate): void => {
    for (const listener of costUsageListeners) {
      try {
        listener(usage);
      } catch (err) {
        console.error('[session] cost usage listener threw', err);
      }
    }
  };

  // Stamp one body with this session's identity + ordering, push it onto the bounded
  // ring buffer (oldest dropped), and return the frozen event. Shared by transcript
  // capture (from the engine stream) and the user-text echo (from sendInput).
  const pushEvent = (s: LiveSession, body: TranscriptEventBody): TranscriptEvent => {
    const event = Object.freeze<TranscriptEvent>({
      ...body,
      sessionId: s.id,
      seq: s.seq++,
      ts: Date.now(),
    });
    s.transcript.push(event);
    if (s.transcript.length > MAX_TRANSCRIPT_EVENTS) s.transcript.shift();
    return event;
  };

  // Persist one `result` body's cost/usage figures to the ledger and emit the updated
  // aggregate. Guarded: a throw here (store failure) is logged and swallowed — it must
  // never flip the session's status or break the consume loop (AC5-style isolation).
  const isFiniteNonNegative = (n: number): boolean => Number.isFinite(n) && n >= 0;

  const recordCost = (s: LiveSession, body: Extract<TranscriptEventBody, { kind: 'result' }>): void => {
    if (costLedger === undefined) return;
    // Validate at the boundary: a NaN/Infinity/negative from the SDK would poison the
    // account-wide SUM broadcast to every client. Drop (and log) rather than persist it.
    if (
      !isFiniteNonNegative(body.inputTokens) ||
      !isFiniteNonNegative(body.outputTokens) ||
      !isFiniteNonNegative(body.totalCostUsd)
    ) {
      console.error(
        `[session] cost ledger skipping non-finite/negative usage for ${s.id}`,
        { inputTokens: body.inputTokens, outputTokens: body.outputTokens, totalCostUsd: body.totalCostUsd },
      );
      return;
    }
    try {
      costLedger.insert({
        sessionId: s.id,
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens,
        costUsd: body.totalCostUsd,
        at: Date.now(),
      });
      emitCostUsage(costLedger.costToday());
    } catch (err) {
      console.error(`[session] cost ledger recording for ${s.id} threw`, err);
    }
  };

  // Normalize one engine message into stamped transcript events, push them onto the
  // session's bounded ring buffer, and fan the frozen batch out to listeners.
  const captureTranscript = (s: LiveSession, message: EngineMessage): void => {
    const bodies = normalizeMessage(message);
    if (bodies.length === 0) return;
    const batch: TranscriptEvent[] = bodies.map((body) => pushEvent(s, body));
    emitTranscript(s, Object.freeze(batch));
    for (const body of bodies) {
      if (body.kind === 'result') recordCost(s, body);
    }
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
      engine = query({
        cwd: projectPath,
        role,
        prompt: input.prompt ?? DEFAULT_PROMPT,
        model: input.model ?? DEFAULT_MODEL,
        effort: input.effort ?? DEFAULT_EFFORT,
      });
    } catch (err) {
      release();
      store.updateStatus(id, 'errored');
      throw err;
    }

    const session: LiveSession = {
      id,
      projectPath,
      role,
      workItemId: input.workItemId ?? null,
      status: 'running',
      sdkSessionId: null,
      seq: 0,
      transcript: [],
      engine,
      permissionToolNames: new Map(),
    };
    live.set(id, session);
    emit(session); // running

    // Register the permission relay BEFORE starting the consume loop, so no early
    // request can be raised without a listener attached.
    engine.onPermissionRequest((req) => {
      session.permissionToolNames.set(req.requestId, req.toolName);
      emitPermission(session, req);
    });

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

  const onPermissionRequest = (listener: PermissionRequestListener): (() => void) => {
    permissionRequestListeners.add(listener);
    return () => permissionRequestListeners.delete(listener);
  };

  const onCostUsage = (listener: CostUsageListener): (() => void) => {
    costUsageListeners.add(listener);
    return () => costUsageListeners.delete(listener);
  };

  const getTranscript = (id: string): readonly TranscriptEvent[] => {
    const s = live.get(id);
    return s === undefined ? [] : Object.freeze([...s.transcript]);
  };

  const sendInput = (id: string, text: string): void => {
    const s = live.get(id);
    if (s === undefined) {
      // Unknown/ended session — guarded no-op (a late steer after teardown, not an error path).
      console.error(`[session] sendInput: no live session ${id}`);
      return;
    }
    // Echo the human's own message into the transcript FIRST — the SDK does not echo
    // streaming-input on the output stream, so without this the typed message is silent.
    const echo = pushEvent(
      s,
      Object.freeze<TranscriptEventBody>({
        kind: 'user-text',
        text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text,
      }),
    );
    emitTranscript(s, Object.freeze([echo]));
    // Push the FULL text into the live input stream (ws-protocol already bounds it at
    // MAX_STEER_TEXT_LENGTH; only the transcript echo is truncated for frame size).
    // Per-session isolated: a throw or async rejection is logged, never rethrown.
    try {
      void s.engine.send(text).catch((err) => {
        console.error(`[session] sendInput: engine.send rejected for ${id}`, err);
      });
    } catch (err) {
      console.error(`[session] sendInput: engine.send threw for ${id}`, err);
    }
  };

  const interrupt = async (id: string): Promise<void> => {
    const s = live.get(id);
    if (s === undefined) {
      // Unknown/ended session — guarded no-op.
      console.error(`[session] interrupt: no live session ${id}`);
      return;
    }
    // Interrupt the current turn only. Do NOT change status: the session stays `running`
    // — the consume loop keeps consuming the stream (turn-abort is the SDK's job).
    try {
      await s.engine.interrupt();
    } catch (err) {
      console.error(`[session] interrupt failed for ${id}`, err);
    }
  };

  const resolvePermission = (id: string, requestId: string, decision: PermissionDecision): void => {
    const s = live.get(id);
    if (s === undefined) {
      // Unknown/ended session — guarded no-op.
      console.error(`[session] resolvePermission: no live session ${id}`);
      return;
    }
    // Idempotency guard: only a request that is actually pending for THIS session is
    // resolved + audited. `permissionToolNames` holds an entry from when the request was
    // raised until it is resolved here, so an unknown/stale/duplicate requestId (a second
    // tab's click, or a forged decision) finds no entry and is a silent no-op — matching
    // the broker's idempotent `resolve` and keeping the audit trail honest.
    const toolName = s.permissionToolNames.get(requestId);
    if (toolName === undefined) {
      return;
    }
    // Prune the entry as we resolve it: bounds the map's growth over a long session
    // (the broker's `pending` map is capped at MAX_PENDING_PERMISSIONS; this side map was not)
    // and ensures a repeat decision for the same requestId is the no-op above.
    s.permissionToolNames.delete(requestId);
    // Per-session isolated: a throw is logged, never rethrown.
    try {
      s.engine.resolvePermission(requestId, decision);
    } catch (err) {
      console.error(`[session] resolvePermission: engine.resolvePermission threw for ${id}`, err);
    }
    // Audit trail: record the decision as a transcript event.
    const event = pushEvent(
      s,
      Object.freeze<TranscriptEventBody>({
        kind: 'permission',
        requestId,
        toolName,
        decision,
      }),
    );
    emitTranscript(s, Object.freeze([event]));
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

  return Object.freeze<SessionManager>({
    spawn,
    list,
    get,
    onState,
    onTranscript,
    onPermissionRequest,
    onCostUsage,
    getTranscript,
    sendInput,
    interrupt,
    resolvePermission,
    stopAll,
  });
}
