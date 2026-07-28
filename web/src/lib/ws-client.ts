// Framework-agnostic reconnecting WebSocket client for the heartbeat transport.
//
// The browser always dials `ws://${location.host}/ws` — Vite proxies `/ws` to the
// Node server in dev, and the same-origin server accepts the upgrade in prod, so the
// URL resolves identically in both modes (see docs/ARCHITECTURE.md).
//
// Design notes:
//  - Immutable state: every transition builds a NEW state object; nothing is mutated.
//  - Injectable seams: the WebSocket constructor and the timer functions are options,
//    so tests can drive a fake socket + fake timers deterministically.
//  - Boundary validation: each incoming frame is parsed and shape-checked; malformed
//    frames are dropped with a console.warn and never throw into the app.

export const WS_PATH = '/ws';

/** Connection lifecycle states surfaced to subscribers. */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** A validated heartbeat frame. Frozen — never mutated after construction. */
export interface Heartbeat {
  readonly seq: number;
  readonly ts: number;
}

/**
 * A validated registry project entry. Mirrors the server's ProjectAnchor
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface RegistryProject {
  readonly path: string;
  readonly displayName: string | null;
  readonly pinned: boolean;
  readonly uiPrefs: unknown;
  readonly createdAt: number;
}

/**
 * A validated discovery candidate entry. Mirrors the server's Candidate
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface RegistryCandidate {
  readonly path: string;
  readonly displayName: string | null;
  readonly hasClaudeInstall: boolean;
}

/**
 * A validated git-state snapshot. Mirrors the server's GitState
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface GitState {
  readonly path: string;
  readonly isRepo: boolean;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly dirty: boolean;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly upstream: string | null;
}

/**
 * A validated next-task entry. Mirrors the server's TrackerTask
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface TrackerTask {
  readonly id: string;
  readonly title: string;
  readonly priority: number | null;
  readonly url: string | null;
}

/**
 * A validated tracker-state snapshot. Mirrors the server's TrackerState
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface TrackerState {
  readonly path: string;
  readonly reachable: boolean;
  readonly tracker: string | null;
  readonly nextTask: TrackerTask | null;
}

/**
 * Validated server-derived lifecycle signals. Mirrors the server's LifecycleSignals
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package. The
 * whole-project STAGE is composed on the client (web/src/lib/lifecycle.ts) from these
 * signals plus the card's already-fetched TrackerState. Frozen — never mutated.
 */
export interface LifecycleSignals {
  readonly hasDecideDocs: boolean;
  readonly hasDefineDocs: boolean;
  readonly hasStartedStory: boolean;
  readonly hasFeatureBranchCommits: boolean;
  readonly hasReleaseTags: boolean;
}

/**
 * A validated owned-session live-state snapshot. Mirrors the server's SessionState
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface SessionState {
  readonly id: string;
  readonly projectPath: string;
  readonly role: string;
  readonly status: string;
  readonly sdkSessionId: string | null;
}

/**
 * One normalized transcript event body — the payload of a live session's SDK
 * message stream. Mirrors the server's TranscriptEventBody
 * (server/src/ws-protocol.ts, the source of truth) — duplicated typed contract,
 * no shared package. Discriminated on `kind`. Frozen — never mutated.
 */
export type TranscriptEventBody =
  | { readonly kind: 'init' }
  | { readonly kind: 'assistant-text'; readonly text: string }
  | {
      readonly kind: 'tool-use';
      readonly toolName: string;
      readonly toolInput: string;
      readonly toolUseId: string | null;
    }
  | {
      readonly kind: 'tool-result';
      readonly toolUseId: string | null;
      readonly content: string;
      readonly isError: boolean;
    }
  | {
      readonly kind: 'result';
      readonly durationMs: number;
      readonly numTurns: number;
      readonly totalCostUsd: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly isError: boolean;
    }
  | { readonly kind: 'user-text'; readonly text: string };

/**
 * A transcript event body stamped with its session identity + ordering. Mirrors
 * the server's TranscriptEvent (server/src/ws-protocol.ts, the source of truth).
 */
export type TranscriptEvent = TranscriptEventBody & {
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: number;
};

/**
 * One parked bridge-inbox item — an interrupt, question, or escalation waiting
 * on human input. Mirrors the server's inbox entry shape
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface BridgeInboxItem {
  readonly stage: string;
  readonly kind: 'interrupt' | 'question' | 'escalation';
  readonly reason: string;
  readonly ts: number;
}

/**
 * A validated bridge-state snapshot. Mirrors the server's BridgeStateSnapshot
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface BridgeState {
  readonly path: string;
  readonly stage: string;
  readonly gate: 'running' | 'awaiting-approval' | 'reworking' | 'escalated' | 'done';
  readonly sessionId: string | null;
  readonly inbox: readonly BridgeInboxItem[];
}

/** The slice of the WebSocket API this client depends on (keeps fakes tiny). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Injectable factory for the underlying socket (default: global `WebSocket`). */
export type WebSocketFactory = (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

/** Injectable timer seam so tests can use fake timers without touching globals. */
export interface Timers {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface WsClientOptions {
  /** Override the dial URL (default: `ws://${location.host}/ws`). */
  readonly url?: string;
  /** Override the socket constructor (default: global `WebSocket`). */
  readonly createWebSocket?: WebSocketFactory;
  /** Override the timer functions (default: global set/clearTimeout). */
  readonly timers?: Timers;
  /** First reconnect delay in ms (default 250). */
  readonly initialBackoffMs?: number;
  /** Backoff ceiling in ms (default 5000). */
  readonly maxBackoffMs?: number;
  /**
   * Override how the local WS auth token is read (default: `readToken`, which
   * reads the injected `<meta name="devos-ws-token">`). Returns null when absent.
   */
  readonly getAuthToken?: () => string | null;
}

export type StatusListener = (status: ConnectionStatus) => void;
export type HeartbeatListener = (heartbeat: Heartbeat) => void;
export type RegistryListener = (projects: readonly RegistryProject[]) => void;
export type CandidateListener = (candidates: readonly RegistryCandidate[]) => void;
export type GitStateListener = (path: string, state: GitState) => void;
export type TrackerStateListener = (path: string, state: TrackerState) => void;
export type LifecycleSignalsListener = (path: string, signals: LifecycleSignals) => void;
export type SessionStateListener = (path: string, session: SessionState) => void;
export type SessionTranscriptListener = (
  path: string,
  sessionId: string,
  events: readonly TranscriptEvent[],
) => void;
export type BridgeStateListener = (path: string, state: BridgeState) => void;

/** Public, framework-agnostic client surface. */
export interface WsClient {
  readonly getStatus: () => ConnectionStatus;
  /** Subscribe to status changes; the current status is emitted immediately. */
  readonly onStatus: (listener: StatusListener) => () => void;
  /** Subscribe to validated heartbeats. */
  readonly onHeartbeat: (listener: HeartbeatListener) => () => void;
  /** Subscribe to validated registry snapshots. */
  readonly onRegistry: (listener: RegistryListener) => () => void;
  /** Subscribe to validated discovery-candidate snapshots. */
  readonly onCandidates: (listener: CandidateListener) => () => void;
  /** Subscribe to validated git-state snapshots. */
  readonly onGitState: (listener: GitStateListener) => () => void;
  /** Subscribe to validated tracker-state snapshots. */
  readonly onTrackerState: (listener: TrackerStateListener) => () => void;
  /** Subscribe to validated lifecycle-signals snapshots. */
  readonly onLifecycleSignals: (listener: LifecycleSignalsListener) => () => void;
  /** Subscribe to validated owned-session state snapshots. */
  readonly onSessionState: (listener: SessionStateListener) => () => void;
  /** Subscribe to validated owned-session transcript batches. */
  readonly onSessionTranscript: (listener: SessionTranscriptListener) => () => void;
  /** Subscribe to validated bridge-state snapshots. */
  readonly onBridgeState: (listener: BridgeStateListener) => () => void;
  /** Pin a project by absolute path; no-op (warns) when the socket is not open. */
  readonly pin: (path: string, opts?: { displayName?: string; uiPrefs?: unknown }) => void;
  /** Unpin a project by absolute path; no-op (warns) when the socket is not open. */
  readonly unpin: (path: string) => void;
  /** Request a fresh discovery of candidate projects; no-op (warns) when the socket is not open. */
  readonly discover: () => void;
  /** Request the current git state for a project path; no-op (warns) when the socket is not open. */
  readonly requestGitState: (path: string) => void;
  /** Request the current tracker state for a project path; no-op (warns) when the socket is not open. */
  readonly requestTrackerState: (path: string) => void;
  /** Request the current lifecycle signals for a project path; no-op (warns) when the socket is not open. */
  readonly requestLifecycleSignals: (path: string) => void;
  /** Spawn an owned session for a pinned project + role; no-op (warns) when the socket is not open. */
  readonly spawnSession: (path: string, role: string, workItemId?: string) => void;
  /** Request the buffered transcript of a live owned session; no-op (warns) when the socket is not open. */
  readonly requestTranscript: (sessionId: string) => void;
  /** Steer a live owned session with mid-run user text; no-op (warns) when the socket is not open. */
  readonly sendSessionInput: (sessionId: string, text: string) => void;
  /** Interrupt a live owned session's current turn; no-op (warns) when the socket is not open. */
  readonly interruptSession: (sessionId: string) => void;
  /** Start (or resume) a bridge run for a project path; no-op (warns) when the socket is not open. */
  readonly sendBridgeStart: (path: string, workItemId?: string) => void;
  /** Approve the current gate for a bridge run; no-op (warns) when the socket is not open. */
  readonly sendGateApprove: (path: string) => void;
  /** Interrupt a running bridge with a reason; no-op (warns) when the socket is not open. */
  readonly sendBridgeInterrupt: (path: string, reason: string) => void;
  /** Tear down: cancels reconnects, closes the socket, drops subscribers. */
  readonly close: () => void;
}

interface ClientState {
  readonly status: ConnectionStatus;
  readonly socket: WebSocketLike | null;
  readonly backoffMs: number;
  readonly reconnectHandle: unknown | null;
  readonly closed: boolean;
}

const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5000;

/** `WebSocket.OPEN` readyState value — hardcoded so fakes need no constants. */
const WS_OPEN = 1;

const defaultTimers: Timers = {
  // Call through the global at invocation time so vi.useFakeTimers() is honored.
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultCreateWebSocket: WebSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

function defaultUrl(): string {
  return `ws://${location.host}${WS_PATH}`;
}

/** The fixed subprotocol every dial offers so the server handshake completes. */
const SUBPROTOCOL = 'devos';
/** Prefix for the local-token subprotocol entry (`token.<hex>`). */
const TOKEN_PROTO_PREFIX = 'token.';

/**
 * Read the local WS auth token injected into the served page as
 * `<meta name="devos-ws-token" content="…">`. Returns null when the DOM is
 * unavailable (SSR/tests) or the meta tag is absent.
 */
function readToken(): string | null {
  if (typeof document === 'undefined') return null;
  return document
    .querySelector('meta[name="devos-ws-token"]')
    ?.getAttribute('content') ?? null;
}

/**
 * Build the subprotocol list offered on dial: always `['devos']`, plus a
 * `token.<hex>` entry when a non-empty token is present.
 */
function buildProtocols(token: string | null): string[] {
  const protocols = [SUBPROTOCOL];
  if (token !== null && token.length > 0) {
    protocols.push(TOKEN_PROTO_PREFIX + token);
  }
  return protocols;
}

/**
 * Validate a raw WS frame against the pinned heartbeat contract:
 * `{ type: 'heartbeat', seq: <finite number>, ts: <finite number> }`.
 * Returns a frozen Heartbeat, or null for anything malformed.
 */
function parseHeartbeat(data: unknown): Heartbeat | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'heartbeat') return null;

  const { seq, ts } = frame;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;

  return Object.freeze({ seq, ts });
}

/**
 * Validate a single raw entry against the ProjectAnchor contract:
 * `{ path: string, displayName: string|null, pinned: boolean, uiPrefs: unknown, createdAt: <finite number> }`.
 * Returns a frozen RegistryProject, or null for anything malformed.
 */
function parseRegistryProject(entry: unknown): RegistryProject | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { path, displayName, pinned, createdAt } = record;

  if (typeof path !== 'string') return null;
  if (displayName !== null && typeof displayName !== 'string') return null;
  if (typeof pinned !== 'boolean') return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;

  return Object.freeze({ path, displayName, pinned, uiPrefs: record.uiPrefs, createdAt });
}

/**
 * Validate a raw WS frame against the pinned registry contract:
 * `{ type: 'registry', projects: RegistryProject[] }`.
 * Returns a frozen array of frozen projects, or null for anything malformed.
 */
function parseRegistry(data: unknown): readonly RegistryProject[] | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'registry') return null;
  if (!Array.isArray(frame.projects)) return null;

  const projects: RegistryProject[] = [];
  for (const entry of frame.projects) {
    const project = parseRegistryProject(entry);
    if (project === null) return null;
    projects.push(project);
  }

  return Object.freeze(projects);
}

/**
 * Validate a single raw entry against the Candidate contract:
 * `{ path: string, displayName: string|null, hasClaudeInstall: boolean }`.
 * Returns a frozen RegistryCandidate, or null for anything malformed.
 */
function parseCandidate(entry: unknown): RegistryCandidate | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { path, displayName, hasClaudeInstall } = record;

  if (typeof path !== 'string' || path.length === 0) return null;
  if (displayName !== null && typeof displayName !== 'string') return null;
  if (typeof hasClaudeInstall !== 'boolean') return null;

  return Object.freeze({ path, displayName, hasClaudeInstall });
}

/**
 * Validate a raw WS frame against the pinned candidates contract:
 * `{ type: 'candidates', candidates: Candidate[] }`.
 * Returns a frozen array of frozen candidates, or null for anything malformed.
 */
function parseCandidates(data: unknown): readonly RegistryCandidate[] | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'candidates') return null;
  if (!Array.isArray(frame.candidates)) return null;

  const candidates: RegistryCandidate[] = [];
  for (const entry of frame.candidates) {
    const candidate = parseCandidate(entry);
    if (candidate === null) return null;
    candidates.push(candidate);
  }

  return Object.freeze(candidates);
}

/**
 * Validate a single raw entry against the GitState contract:
 * `{ path: string, isRepo: boolean, branch: string|null, detached: boolean,
 *    dirty: boolean, ahead: number|null, behind: number|null, upstream: string|null }`.
 * `ahead`/`behind` must be a finite number or null (NaN/Infinity/non-number rejected).
 * Returns a frozen GitState, or null for anything malformed.
 */
function parseGitState(entry: unknown): GitState | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { path, isRepo, branch, detached, dirty, ahead, behind, upstream } = record;

  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof isRepo !== 'boolean') return null;
  if (branch !== null && typeof branch !== 'string') return null;
  if (typeof detached !== 'boolean') return null;
  if (typeof dirty !== 'boolean') return null;
  if (ahead !== null && (typeof ahead !== 'number' || !Number.isFinite(ahead))) return null;
  if (behind !== null && (typeof behind !== 'number' || !Number.isFinite(behind))) return null;
  if (upstream !== null && typeof upstream !== 'string') return null;

  return Object.freeze({ path, isRepo, branch, detached, dirty, ahead, behind, upstream });
}

/**
 * Validate a raw WS frame against the pinned git-state contract:
 * `{ type: 'git-state', path: string, state: GitState }`.
 * Returns a frozen `{ path, state }`, or null for anything malformed.
 */
function parseGitStateSnapshot(data: unknown): { path: string; state: GitState } | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'git-state') return null;
  if (typeof frame.path !== 'string' || frame.path.length === 0) return null;

  const state = parseGitState(frame.state);
  if (state === null) return null;

  return Object.freeze({ path: frame.path, state });
}

/**
 * Validate a single raw entry against the TrackerTask contract:
 * `{ id: string, title: string, priority: number|null, url: string|null }`.
 * `priority` must be a finite number or null (NaN/Infinity/non-number rejected).
 * Returns a frozen TrackerTask, or null for anything malformed.
 */
function parseTrackerTask(entry: unknown): TrackerTask | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { id, title, priority, url } = record;

  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof title !== 'string') return null;
  if (priority !== null && (typeof priority !== 'number' || !Number.isFinite(priority))) {
    return null;
  }
  if (url !== null && typeof url !== 'string') return null;

  return Object.freeze({ id, title, priority, url });
}

/**
 * Validate a single raw entry against the TrackerState contract:
 * `{ path: string, reachable: boolean, tracker: string|null, nextTask: TrackerTask|null }`.
 * Returns a frozen TrackerState, or null for anything malformed.
 */
function parseTrackerState(entry: unknown): TrackerState | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { path, reachable, tracker, nextTask } = record;

  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof reachable !== 'boolean') return null;
  if (tracker !== null && typeof tracker !== 'string') return null;

  let parsedNextTask: TrackerTask | null = null;
  if (nextTask !== null) {
    parsedNextTask = parseTrackerTask(nextTask);
    if (parsedNextTask === null) return null;
  }

  return Object.freeze({ path, reachable, tracker, nextTask: parsedNextTask });
}

/**
 * Validate a raw WS frame against the pinned tracker-state contract:
 * `{ type: 'tracker-state', path: string, state: TrackerState }`.
 * Returns a frozen `{ path, state }`, or null for anything malformed.
 */
function parseTrackerStateSnapshot(
  data: unknown,
): { path: string; state: TrackerState } | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'tracker-state') return null;
  if (typeof frame.path !== 'string' || frame.path.length === 0) return null;

  const state = parseTrackerState(frame.state);
  if (state === null) return null;

  return Object.freeze({ path: frame.path, state });
}

/**
 * Validate a single raw entry against the LifecycleSignals contract: five booleans.
 * Returns a frozen LifecycleSignals, or null for anything malformed.
 */
function parseLifecycleSignals(entry: unknown): LifecycleSignals | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const keys: readonly (keyof LifecycleSignals)[] = [
    'hasDecideDocs',
    'hasDefineDocs',
    'hasStartedStory',
    'hasFeatureBranchCommits',
    'hasReleaseTags',
  ];
  for (const key of keys) {
    if (typeof record[key] !== 'boolean') return null;
  }

  return Object.freeze({
    hasDecideDocs: record.hasDecideDocs as boolean,
    hasDefineDocs: record.hasDefineDocs as boolean,
    hasStartedStory: record.hasStartedStory as boolean,
    hasFeatureBranchCommits: record.hasFeatureBranchCommits as boolean,
    hasReleaseTags: record.hasReleaseTags as boolean,
  });
}

/**
 * Validate a raw WS frame against the pinned lifecycle-signals contract:
 * `{ type: 'lifecycle-signals', path: string, state: { path, signals } }`.
 * Returns a frozen `{ path, signals }`, or null for anything malformed.
 */
function parseLifecycleSignalsSnapshot(
  data: unknown,
): { path: string; signals: LifecycleSignals } | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'lifecycle-signals') return null;
  if (typeof frame.path !== 'string' || frame.path.length === 0) return null;

  if (typeof frame.state !== 'object' || frame.state === null) return null;
  const signals = parseLifecycleSignals((frame.state as Record<string, unknown>).signals);
  if (signals === null) return null;

  return Object.freeze({ path: frame.path, signals });
}

/**
 * Validate a single raw entry against the SessionState contract:
 * `{ id: string, projectPath: string, role: string, status: string, sdkSessionId: string|null }`.
 * Returns a frozen SessionState, or null for anything malformed.
 */
function parseSessionState(entry: unknown): SessionState | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { id, projectPath, role, status, sdkSessionId } = record;

  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof projectPath !== 'string' || projectPath.length === 0) return null;
  if (typeof role !== 'string') return null;
  if (typeof status !== 'string') return null;
  if (sdkSessionId !== null && typeof sdkSessionId !== 'string') return null;

  return Object.freeze({ id, projectPath, role, status, sdkSessionId });
}

/**
 * Validate a raw WS frame against the pinned session-state contract:
 * `{ type: 'session-state', path: string, session: SessionState }`.
 * Returns a frozen `{ path, session }`, or null for anything malformed.
 */
function parseSessionStateSnapshot(
  data: unknown,
): { path: string; session: SessionState } | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'session-state') return null;
  if (typeof frame.path !== 'string' || frame.path.length === 0) return null;

  const session = parseSessionState(frame.session);
  if (session === null) return null;

  return Object.freeze({ path: frame.path, session });
}

/**
 * Validate a single raw entry against the TranscriptEvent contract: a `kind`
 * discriminant plus kind-specific fields, stamped with sessionId/seq/ts.
 * Mirrors server/src/ws-protocol.ts (the source of truth).
 * Returns a frozen TranscriptEvent, or null for anything malformed.
 */
function parseTranscriptEvent(entry: unknown): TranscriptEvent | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { kind, sessionId, seq, ts } = record;

  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;

  const stamp = { sessionId, seq, ts } as const;

  if (kind === 'init') {
    return Object.freeze<TranscriptEvent>({ kind: 'init', ...stamp });
  }

  if (kind === 'assistant-text') {
    const { text } = record;
    if (typeof text !== 'string') return null;
    return Object.freeze<TranscriptEvent>({ kind: 'assistant-text', text, ...stamp });
  }

  if (kind === 'user-text') {
    const { text } = record;
    if (typeof text !== 'string') return null;
    return Object.freeze<TranscriptEvent>({ kind: 'user-text', text, ...stamp });
  }

  if (kind === 'tool-use') {
    const { toolName, toolInput, toolUseId } = record;
    if (typeof toolName !== 'string') return null;
    if (typeof toolInput !== 'string') return null;
    if (toolUseId !== null && typeof toolUseId !== 'string') return null;
    return Object.freeze<TranscriptEvent>({ kind: 'tool-use', toolName, toolInput, toolUseId, ...stamp });
  }

  if (kind === 'tool-result') {
    const { toolUseId, content, isError } = record;
    if (toolUseId !== null && typeof toolUseId !== 'string') return null;
    if (typeof content !== 'string') return null;
    if (typeof isError !== 'boolean') return null;
    return Object.freeze<TranscriptEvent>({ kind: 'tool-result', toolUseId, content, isError, ...stamp });
  }

  if (kind === 'result') {
    const { durationMs, numTurns, totalCostUsd, inputTokens, outputTokens, isError } = record;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null;
    if (typeof numTurns !== 'number' || !Number.isFinite(numTurns)) return null;
    if (typeof totalCostUsd !== 'number' || !Number.isFinite(totalCostUsd)) return null;
    if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) return null;
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return null;
    if (typeof isError !== 'boolean') return null;
    return Object.freeze<TranscriptEvent>({
      kind: 'result',
      durationMs,
      numTurns,
      totalCostUsd,
      inputTokens,
      outputTokens,
      isError,
      ...stamp,
    });
  }

  return null; // unknown kind
}

/**
 * Validate a raw WS frame against the pinned session-transcript contract:
 * `{ type: 'session-transcript', path: string, sessionId: string, events: TranscriptEvent[] }`.
 * Returns a frozen `{ path, sessionId, events }`, or null for anything malformed.
 */
function parseSessionTranscriptSnapshot(
  data: unknown,
): { path: string; sessionId: string; events: readonly TranscriptEvent[] } | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'session-transcript') return null;
  if (typeof frame.path !== 'string' || frame.path.length === 0) return null;
  if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) return null;
  if (!Array.isArray(frame.events)) return null;

  const events: TranscriptEvent[] = [];
  for (const entry of frame.events) {
    const event = parseTranscriptEvent(entry);
    if (event === null) return null;
    events.push(event);
  }

  return Object.freeze({
    path: frame.path,
    sessionId: frame.sessionId,
    events: Object.freeze(events),
  });
}

/**
 * Validate a single raw entry against the BridgeInboxItem contract:
 * `{ stage: string, kind: 'interrupt'|'question'|'escalation', reason: string, ts: <finite number> }`.
 * Returns a frozen BridgeInboxItem, or null for anything malformed.
 */
function parseBridgeInboxItem(entry: unknown): BridgeInboxItem | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { stage, kind, reason, ts } = record;

  if (typeof stage !== 'string') return null;
  if (kind !== 'interrupt' && kind !== 'question' && kind !== 'escalation') return null;
  if (typeof reason !== 'string') return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;

  return Object.freeze({ stage, kind, reason, ts });
}

/**
 * Validate a raw WS frame against the pinned bridge-state contract:
 * `{ type: 'bridge-state', path: string, stage: string, gate: <enum>,
 *    sessionId: string|null, inbox: BridgeInboxItem[] }`.
 * Returns a frozen BridgeState, or null for anything malformed.
 */
function parseBridgeState(data: unknown): BridgeState | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'bridge-state') return null;

  const { path, stage, gate, sessionId, inbox } = frame;

  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof stage !== 'string') return null;
  if (
    gate !== 'running' &&
    gate !== 'awaiting-approval' &&
    gate !== 'reworking' &&
    gate !== 'escalated' &&
    gate !== 'done'
  ) {
    return null;
  }
  if (sessionId !== null && typeof sessionId !== 'string') return null;
  if (!Array.isArray(inbox)) return null;

  const items: BridgeInboxItem[] = [];
  for (const entry of inbox) {
    const item = parseBridgeInboxItem(entry);
    if (item === null) return null;
    items.push(item);
  }

  return Object.freeze({ path, stage, gate, sessionId, inbox: Object.freeze(items) });
}

/**
 * Peek the `type` discriminant of a raw frame without full validation, so
 * handleMessage can route to the right parser. Returns null for anything that
 * is not a JSON object with a string `type`. Never throws.
 */
function peekFrameType(data: unknown): string | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { type } = parsed as Record<string, unknown>;
  return typeof type === 'string' ? type : null;
}

/**
 * Create a reconnecting heartbeat WS client and start connecting immediately.
 */
export function createWsClient(options: WsClientOptions = {}): WsClient {
  const url = options.url ?? defaultUrl();
  const createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
  const timers = options.timers ?? defaultTimers;
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const getAuthToken = options.getAuthToken ?? readToken;

  const statusListeners = new Set<StatusListener>();
  const heartbeatListeners = new Set<HeartbeatListener>();
  const registryListeners = new Set<RegistryListener>();
  const candidateListeners = new Set<CandidateListener>();
  const gitStateListeners = new Set<GitStateListener>();
  const trackerStateListeners = new Set<TrackerStateListener>();
  const lifecycleSignalsListeners = new Set<LifecycleSignalsListener>();
  const sessionStateListeners = new Set<SessionStateListener>();
  const sessionTranscriptListeners = new Set<SessionTranscriptListener>();
  const bridgeStateListeners = new Set<BridgeStateListener>();

  let state: ClientState = {
    status: 'connecting',
    socket: null,
    backoffMs: initialBackoffMs,
    reconnectHandle: null,
    closed: false,
  };

  // Immutable transition: replace state, never mutate. Emit only on status change.
  function transition(next: Partial<ClientState>): void {
    const prev = state;
    state = { ...prev, ...next };
    if (next.status !== undefined && next.status !== prev.status) {
      for (const listener of statusListeners) listener(state.status);
    }
  }

  function emitHeartbeat(heartbeat: Heartbeat): void {
    for (const listener of heartbeatListeners) listener(heartbeat);
  }

  function emitRegistry(projects: readonly RegistryProject[]): void {
    for (const listener of registryListeners) listener(projects);
  }

  function emitCandidates(candidates: readonly RegistryCandidate[]): void {
    for (const listener of candidateListeners) listener(candidates);
  }

  function emitGitState(path: string, state: GitState): void {
    for (const listener of gitStateListeners) listener(path, state);
  }

  function emitTrackerState(path: string, state: TrackerState): void {
    for (const listener of trackerStateListeners) listener(path, state);
  }

  function emitLifecycleSignals(path: string, signals: LifecycleSignals): void {
    for (const listener of lifecycleSignalsListeners) listener(path, signals);
  }

  function emitSessionState(path: string, session: SessionState): void {
    for (const listener of sessionStateListeners) listener(path, session);
  }

  function emitSessionTranscript(
    path: string,
    sessionId: string,
    events: readonly TranscriptEvent[],
  ): void {
    for (const listener of sessionTranscriptListeners) listener(path, sessionId, events);
  }

  function emitBridgeState(path: string, bridgeState: BridgeState): void {
    for (const listener of bridgeStateListeners) listener(path, bridgeState);
  }

  // Write a frame only when the socket is OPEN; otherwise drop + warn (never throw).
  function sendFrame(frame: Record<string, unknown>): void {
    const { socket } = state;
    if (socket === null || socket.readyState !== WS_OPEN) {
      console.warn('[ws-client] dropped outgoing frame (socket not open):', frame);
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  function detach(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
  }

  function handleMessage(data: unknown): void {
    const type = peekFrameType(data);

    if (type === 'heartbeat') {
      const heartbeat = parseHeartbeat(data);
      if (heartbeat === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitHeartbeat(heartbeat);
      return;
    }

    if (type === 'registry') {
      const projects = parseRegistry(data);
      if (projects === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitRegistry(projects);
      return;
    }

    if (type === 'candidates') {
      const candidates = parseCandidates(data);
      if (candidates === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitCandidates(candidates);
      return;
    }

    if (type === 'git-state') {
      const snapshot = parseGitStateSnapshot(data);
      if (snapshot === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitGitState(snapshot.path, snapshot.state);
      return;
    }

    if (type === 'tracker-state') {
      const snapshot = parseTrackerStateSnapshot(data);
      if (snapshot === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitTrackerState(snapshot.path, snapshot.state);
      return;
    }

    if (type === 'lifecycle-signals') {
      const snapshot = parseLifecycleSignalsSnapshot(data);
      if (snapshot === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitLifecycleSignals(snapshot.path, snapshot.signals);
      return;
    }

    if (type === 'session-state') {
      const snapshot = parseSessionStateSnapshot(data);
      if (snapshot === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitSessionState(snapshot.path, snapshot.session);
      return;
    }

    if (type === 'session-transcript') {
      const snapshot = parseSessionTranscriptSnapshot(data);
      if (snapshot === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitSessionTranscript(snapshot.path, snapshot.sessionId, snapshot.events);
      return;
    }

    if (type === 'bridge-state') {
      const bridgeState = parseBridgeState(data);
      if (bridgeState === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitBridgeState(bridgeState.path, bridgeState);
      return;
    }

    // Never throw into the app — drop and warn.
    console.warn('[ws-client] dropped malformed frame:', data);
  }

  function scheduleReconnect(): void {
    if (state.closed) return;
    const delay = state.backoffMs;
    const handle = timers.setTimeout(() => {
      transition({ reconnectHandle: null });
      connect();
    }, delay);
    // Grow backoff for the NEXT consecutive failure; a successful open resets it.
    transition({
      reconnectHandle: handle,
      backoffMs: Math.min(delay * 2, maxBackoffMs),
    });
  }

  function handleDisconnect(socket: WebSocketLike): void {
    if (state.closed) return;
    // Ignore late events from a socket we've already replaced.
    if (state.socket !== socket) return;
    detach(socket);
    transition({ status: 'disconnected', socket: null });
    scheduleReconnect();
  }

  function connect(): void {
    if (state.closed) return;
    transition({ status: 'connecting' });

    const protocols = buildProtocols(getAuthToken());
    const socket = createWebSocket(url, protocols);
    transition({ socket });

    socket.onopen = () => {
      if (state.closed || state.socket !== socket) return;
      // Successful open resets the backoff schedule.
      transition({ status: 'connected', backoffMs: initialBackoffMs });
    };
    socket.onmessage = (ev) => {
      if (state.closed || state.socket !== socket) return;
      handleMessage(ev.data);
    };
    socket.onclose = () => handleDisconnect(socket);
    socket.onerror = () => {
      // A connection error is followed by onclose, which drives reconnect.
    };
  }

  function close(): void {
    // Drop subscribers first so teardown never calls back into unmounted UI.
    statusListeners.clear();
    heartbeatListeners.clear();
    registryListeners.clear();
    candidateListeners.clear();
    gitStateListeners.clear();
    trackerStateListeners.clear();
    lifecycleSignalsListeners.clear();
    sessionStateListeners.clear();
    sessionTranscriptListeners.clear();
    bridgeStateListeners.clear();

    if (state.reconnectHandle !== null) {
      timers.clearTimeout(state.reconnectHandle);
    }
    const { socket } = state;
    if (socket !== null) {
      detach(socket);
      try {
        socket.close();
      } catch {
        // Socket may already be closing; teardown is best-effort.
      }
    }
    state = { ...state, closed: true, status: 'disconnected', socket: null, reconnectHandle: null };
  }

  function pin(path: string, opts?: { displayName?: string; uiPrefs?: unknown }): void {
    // Conditional spreads omit absent optional fields rather than sending undefined.
    sendFrame({
      type: 'pin',
      path,
      ...(opts?.displayName !== undefined ? { displayName: opts.displayName } : {}),
      ...(opts?.uiPrefs !== undefined ? { uiPrefs: opts.uiPrefs } : {}),
    });
  }

  function unpin(path: string): void {
    sendFrame({ type: 'unpin', path });
  }

  function discover(): void {
    sendFrame({ type: 'discover' });
  }

  function requestGitState(path: string): void {
    sendFrame({ type: 'git-state', path });
  }

  function requestTrackerState(path: string): void {
    sendFrame({ type: 'tracker-state', path });
  }

  function requestLifecycleSignals(path: string): void {
    sendFrame({ type: 'lifecycle-signals', path });
  }

  function spawnSession(path: string, role: string, workItemId?: string): void {
    sendFrame({
      type: 'session-spawn',
      path,
      role,
      ...(workItemId !== undefined ? { workItemId } : {}),
    });
  }

  function requestTranscript(sessionId: string): void {
    sendFrame({ type: 'session-transcript-request', sessionId });
  }

  function sendSessionInput(sessionId: string, text: string): void {
    sendFrame({ type: 'session-input', sessionId, text });
  }

  function interruptSession(sessionId: string): void {
    sendFrame({ type: 'session-interrupt', sessionId });
  }

  function sendBridgeStart(path: string, workItemId?: string): void {
    sendFrame({
      type: 'bridge-start',
      path,
      ...(workItemId !== undefined ? { workItemId } : {}),
    });
  }

  function sendGateApprove(path: string): void {
    sendFrame({ type: 'gate-approve', path });
  }

  function sendBridgeInterrupt(path: string, reason: string): void {
    sendFrame({ type: 'bridge-interrupt', path, reason });
  }

  connect();

  return {
    getStatus: () => state.status,
    onStatus: (listener) => {
      statusListeners.add(listener);
      listener(state.status); // sync the subscriber to the current status
      return () => {
        statusListeners.delete(listener);
      };
    },
    onHeartbeat: (listener) => {
      heartbeatListeners.add(listener);
      return () => {
        heartbeatListeners.delete(listener);
      };
    },
    onRegistry: (listener) => {
      registryListeners.add(listener);
      return () => {
        registryListeners.delete(listener);
      };
    },
    onCandidates: (listener) => {
      candidateListeners.add(listener);
      return () => {
        candidateListeners.delete(listener);
      };
    },
    onGitState: (listener) => {
      gitStateListeners.add(listener);
      return () => {
        gitStateListeners.delete(listener);
      };
    },
    onTrackerState: (listener) => {
      trackerStateListeners.add(listener);
      return () => {
        trackerStateListeners.delete(listener);
      };
    },
    onLifecycleSignals: (listener) => {
      lifecycleSignalsListeners.add(listener);
      return () => {
        lifecycleSignalsListeners.delete(listener);
      };
    },
    onSessionState: (listener) => {
      sessionStateListeners.add(listener);
      return () => {
        sessionStateListeners.delete(listener);
      };
    },
    onSessionTranscript: (listener) => {
      sessionTranscriptListeners.add(listener);
      return () => {
        sessionTranscriptListeners.delete(listener);
      };
    },
    onBridgeState: (listener) => {
      bridgeStateListeners.add(listener);
      return () => {
        bridgeStateListeners.delete(listener);
      };
    },
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
    close,
  };
}
