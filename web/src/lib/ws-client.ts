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
  readonly workItemId: string | null;
  readonly rateLimited: boolean;
}

/**
 * One owned session's persona identity — role x its story's live phase, joined
 * against the roster. Mirrors the server's SessionPersona (server/src/ws-protocol.ts)
 * — duplicated typed contract, no shared package. `phase` is typed as a plain
 * string here — the client doesn't import the server's Phase union. Frozen —
 * never mutated after construction.
 */
export interface SessionPersona {
  readonly sessionId: string;
  readonly workItemId: string | null;
  readonly role: string;
  readonly phase: string | null;
  readonly persona: string | null;
}

/**
 * One work item's owned session anchor. Mirrors the server's WorkItemSessionAnchor
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface WorkItemSessionAnchor {
  readonly id: string;
  readonly role: string | null;
  readonly status: string | null;
  readonly sdkSessionId: string | null;
  readonly currentStage: string | null;
  readonly createdAt: number;
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
      readonly cacheReadInputTokens: number;
      readonly cacheCreationInputTokens: number;
      readonly isError: boolean;
    }
  | { readonly kind: 'user-text'; readonly text: string }
  | {
      readonly kind: 'permission';
      readonly requestId: string;
      readonly toolName: string;
      readonly decision: 'allow' | 'deny' | 'allow-always';
    };

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
  readonly reworkCount: number;
}

/**
 * A validated permission request. Mirrors the server's PermissionRequestSnapshot
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface PermissionRequest {
  readonly path: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly toolUseId: string | null;
  readonly toolName: string;
  readonly title: string | null;
  readonly input: string;
}

/**
 * A validated foreign-session needs-you signal. Mirrors the server's
 * ForeignSessionNeedsYouSnapshot (server/src/ws-protocol.ts) — duplicated
 * typed contract, no shared package. Frozen — never mutated after construction.
 */
export interface ForeignNeedsYou {
  readonly path: string;
  readonly sessionId: string;
  readonly kind: 'permission_prompt' | 'idle_prompt' | 'agent_needs_input';
  readonly reason: string;
  readonly ts: number;
  readonly cleared: boolean;
}

/**
 * A validated hook-bus liveness snapshot. Mirrors the server's
 * HookBusLivenessSnapshot (server/src/ws-protocol.ts) — duplicated typed
 * contract, no shared package. Frozen — never mutated after construction.
 */
export interface HookBusLiveness {
  readonly connected: boolean;
  readonly lastReceivedAt: number | null;
}

/**
 * A validated cost/usage snapshot. Mirrors the server's CostUsageSnapshot
 * (server/src/ws-protocol.ts) — duplicated typed contract, no shared package.
 * Frozen — never mutated after construction.
 */
export interface CostUsage {
  readonly costTodayUsd: number;
  readonly inputTokensToday: number;
  readonly outputTokensToday: number;
  readonly sinceEpochMs: number;
}

/**
 * One roster phase entry within a role's timeline: the phase id and its
 * persona display name. Mirrors the server's RosterTimelineSnapshot entry
 * shape (server/src/ws-protocol.ts) — duplicated typed contract, no shared
 * package. Frozen — never mutated after construction.
 */
export interface RosterTimelineStage {
  readonly phase: string;
  readonly persona: string;
}

/**
 * One role's ordered phase timeline. Mirrors the server's
 * RosterTimelineSnapshot entry shape (server/src/ws-protocol.ts) —
 * duplicated typed contract, no shared package. Frozen — never mutated
 * after construction.
 */
export interface RosterTimelineRole {
  readonly role: string;
  readonly phases: readonly RosterTimelineStage[];
}

/**
 * A validated roster-timeline snapshot. Mirrors the server's
 * RosterTimelineSnapshot (server/src/ws-protocol.ts) — duplicated typed
 * contract, no shared package. Frozen — never mutated after construction.
 */
export interface RosterTimeline {
  readonly path: string;
  readonly roles: readonly RosterTimelineRole[];
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
export type SessionPersonasListener = (
  path: string,
  personas: readonly SessionPersona[],
) => void;
export type WorkItemSessionsListener = (
  path: string,
  workItemId: string,
  sessions: readonly WorkItemSessionAnchor[],
) => void;
export type SessionTranscriptListener = (
  path: string,
  sessionId: string,
  events: readonly TranscriptEvent[],
) => void;
export type BridgeStateListener = (path: string, state: BridgeState) => void;
export type PermissionRequestListener = (request: PermissionRequest) => void;
export type ForeignNeedsYouListener = (item: ForeignNeedsYou) => void;
export type HookBusLivenessListener = (state: HookBusLiveness) => void;
export type CostUsageListener = (usage: CostUsage) => void;
export type RosterTimelineListener = (path: string, timeline: RosterTimeline) => void;

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
  /** Subscribe to validated session-personas snapshots. */
  readonly onSessionPersonas: (listener: SessionPersonasListener) => () => void;
  /** Subscribe to validated work-item-sessions snapshots. */
  readonly onWorkItemSessions: (listener: WorkItemSessionsListener) => () => void;
  /** Subscribe to validated owned-session transcript batches. */
  readonly onSessionTranscript: (listener: SessionTranscriptListener) => () => void;
  /** Subscribe to validated bridge-state snapshots. */
  readonly onBridgeState: (listener: BridgeStateListener) => () => void;
  /** Subscribe to validated permission requests. */
  readonly onPermissionRequest: (listener: PermissionRequestListener) => () => void;
  /** Subscribe to validated foreign-session needs-you signals. */
  readonly onForeignNeedsYou: (listener: ForeignNeedsYouListener) => () => void;
  /** Subscribe to validated hook-bus liveness snapshots. */
  readonly onHookBusLiveness: (listener: HookBusLivenessListener) => () => void;
  /** Subscribe to validated cost/usage snapshots. */
  readonly onCostUsage: (listener: CostUsageListener) => () => void;
  /** Subscribe to validated roster-timeline snapshots. */
  readonly onRosterTimeline: (listener: RosterTimelineListener) => () => void;
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
  /** Request the current session-personas join for a project path; no-op (warns) when the socket is not open. */
  readonly requestSessionPersonas: (path: string) => void;
  /** Request the current roster-timeline join for a project path; no-op (warns) when the socket is not open. */
  readonly requestRosterTimeline: (path: string) => void;
  /** Request the current owned-session anchors for a work item; no-op (warns) when the socket is not open. */
  readonly requestWorkItemSessions: (path: string, workItemId: string) => void;
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
  /** Send an allow/deny decision for a pending permission request; no-op (warns) when the socket is not open. */
  readonly sendPermissionDecision: (
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'allow-always',
  ) => void;
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
 * `{ id: string, projectPath: string, role: string, status: string, sdkSessionId: string|null,
 *    workItemId: string|null, rateLimited: boolean }`.
 * Returns a frozen SessionState, or null for anything malformed.
 */
function parseSessionState(entry: unknown): SessionState | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { id, projectPath, role, status, sdkSessionId, workItemId, rateLimited } = record;

  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof projectPath !== 'string' || projectPath.length === 0) return null;
  if (typeof role !== 'string') return null;
  if (typeof status !== 'string') return null;
  if (sdkSessionId !== null && typeof sdkSessionId !== 'string') return null;
  if (workItemId !== null && typeof workItemId !== 'string') return null;
  if (typeof rateLimited !== 'boolean') return null;

  return Object.freeze({ id, projectPath, role, status, sdkSessionId, workItemId, rateLimited });
}

/**
 * Validate a single raw entry against the SessionPersona contract:
 * `{ sessionId: string, workItemId: string|null, role: string, phase: string|null,
 *    persona: string|null }`.
 * Returns a frozen SessionPersona, or null for anything malformed.
 */
function parseSessionPersona(entry: unknown): SessionPersona | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { sessionId, workItemId, role, phase, persona } = record;

  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (workItemId !== null && typeof workItemId !== 'string') return null;
  if (typeof role !== 'string') return null;
  if (phase !== null && typeof phase !== 'string') return null;
  if (persona !== null && typeof persona !== 'string') return null;

  return Object.freeze({ sessionId, workItemId, role, phase, persona });
}

/**
 * Validate a raw WS frame against the pinned session-personas contract:
 * `{ type: 'session-personas', path: string, personas: SessionPersona[] }`.
 * Returns a frozen `{ path, personas }`, or null for anything malformed.
 */
function parseSessionPersonasSnapshot(
  data: unknown,
): { path: string; personas: readonly SessionPersona[] } | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'session-personas') return null;
  if (typeof frame.path !== 'string' || frame.path.length === 0) return null;
  if (!Array.isArray(frame.personas)) return null;

  const personas: SessionPersona[] = [];
  for (const entry of frame.personas) {
    const persona = parseSessionPersona(entry);
    if (persona === null) return null;
    personas.push(persona);
  }

  return Object.freeze({ path: frame.path, personas: Object.freeze(personas) });
}

/**
 * Validate a single raw entry against the RosterTimelineStage contract:
 * `{ phase: string, persona: string }`.
 * Returns a frozen RosterTimelineStage, or null for anything malformed.
 */
function parseRosterTimelineStage(entry: unknown): RosterTimelineStage | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { phase, persona } = record;

  if (typeof phase !== 'string') return null;
  if (typeof persona !== 'string') return null;

  return Object.freeze({ phase, persona });
}

/**
 * Validate a single raw entry against the RosterTimelineRole contract:
 * `{ role: string, phases: RosterTimelineStage[] }`.
 * Returns a frozen RosterTimelineRole, or null for anything malformed.
 */
function parseRosterTimelineRole(entry: unknown): RosterTimelineRole | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { role, phases } = record;

  if (typeof role !== 'string') return null;
  if (!Array.isArray(phases)) return null;

  const parsedPhases: RosterTimelineStage[] = [];
  for (const phaseEntry of phases) {
    const stage = parseRosterTimelineStage(phaseEntry);
    if (stage === null) return null;
    parsedPhases.push(stage);
  }

  return Object.freeze({ role, phases: Object.freeze(parsedPhases) });
}

/**
 * Validate a raw WS frame against the pinned roster-timeline contract:
 * `{ type: 'roster-timeline', path: string, roles: RosterTimelineRole[] }`.
 * Returns a frozen RosterTimeline, or null for anything malformed.
 */
function parseRosterTimelineSnapshot(data: unknown): RosterTimeline | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'roster-timeline') return null;
  if (typeof frame.path !== 'string' || frame.path.length === 0) return null;
  if (!Array.isArray(frame.roles)) return null;

  const roles: RosterTimelineRole[] = [];
  for (const entry of frame.roles) {
    const role = parseRosterTimelineRole(entry);
    if (role === null) return null;
    roles.push(role);
  }

  return Object.freeze({ path: frame.path, roles: Object.freeze(roles) });
}

/**
 * Validate a single raw entry against the WorkItemSessionAnchor contract:
 * `{ id: string, role: string|null, status: string|null, sdkSessionId: string|null,
 *    currentStage: string|null, createdAt: <finite number> }`.
 * Returns a frozen WorkItemSessionAnchor, or null for anything malformed.
 */
function parseWorkItemSessionAnchor(entry: unknown): WorkItemSessionAnchor | null {
  if (typeof entry !== 'object' || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const { id, role, status, sdkSessionId, currentStage, createdAt } = record;

  if (typeof id !== 'string' || id.length === 0) return null;
  if (role !== null && typeof role !== 'string') return null;
  if (status !== null && typeof status !== 'string') return null;
  if (sdkSessionId !== null && typeof sdkSessionId !== 'string') return null;
  if (currentStage !== null && typeof currentStage !== 'string') return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;

  return Object.freeze({ id, role, status, sdkSessionId, currentStage, createdAt });
}

/**
 * Validate a raw WS frame against the pinned work-item-sessions contract:
 * `{ type: 'work-item-sessions', path: string, workItemId: string, sessions: WorkItemSessionAnchor[] }`.
 * Returns a frozen `{ path, workItemId, sessions }`, or null for anything malformed.
 */
function parseWorkItemSessionsSnapshot(
  data: unknown,
): { path: string; workItemId: string; sessions: readonly WorkItemSessionAnchor[] } | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'work-item-sessions') return null;
  if (typeof frame.path !== 'string' || frame.path.length === 0) return null;
  if (typeof frame.workItemId !== 'string' || frame.workItemId.length === 0) return null;
  if (!Array.isArray(frame.sessions)) return null;

  const sessions: WorkItemSessionAnchor[] = [];
  for (const entry of frame.sessions) {
    const session = parseWorkItemSessionAnchor(entry);
    if (session === null) return null;
    sessions.push(session);
  }

  return Object.freeze({
    path: frame.path,
    workItemId: frame.workItemId,
    sessions: Object.freeze(sessions),
  });
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
    const {
      durationMs,
      numTurns,
      totalCostUsd,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      isError,
    } = record;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null;
    if (typeof numTurns !== 'number' || !Number.isFinite(numTurns)) return null;
    if (typeof totalCostUsd !== 'number' || !Number.isFinite(totalCostUsd)) return null;
    if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) return null;
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return null;
    if (typeof isError !== 'boolean') return null;
    // Cache-token fields are newer than the rest of the result shape — coerce
    // absent/non-finite values to 0 rather than rejecting the whole frame.
    return Object.freeze<TranscriptEvent>({
      kind: 'result',
      durationMs,
      numTurns,
      totalCostUsd,
      inputTokens,
      outputTokens,
      cacheReadInputTokens:
        typeof cacheReadInputTokens === 'number' && Number.isFinite(cacheReadInputTokens)
          ? cacheReadInputTokens
          : 0,
      cacheCreationInputTokens:
        typeof cacheCreationInputTokens === 'number' && Number.isFinite(cacheCreationInputTokens)
          ? cacheCreationInputTokens
          : 0,
      isError,
      ...stamp,
    });
  }

  if (kind === 'permission') {
    const { requestId, toolName, decision } = record;
    if (typeof requestId !== 'string' || requestId.length === 0) return null;
    if (typeof toolName !== 'string') return null;
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'allow-always') return null;
    return Object.freeze<TranscriptEvent>({
      kind: 'permission',
      requestId,
      toolName,
      decision,
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

  const { path, stage, gate, sessionId, inbox, reworkCount: rawReworkCount } = frame;

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

  // Clamp to a non-negative integer: a hostile/garbled frame (negative, huge, or
  // fractional) can't produce a nonsensical loop badge. Missing/non-finite → 0.
  const reworkCount =
    typeof rawReworkCount === 'number' && Number.isFinite(rawReworkCount)
      ? Math.max(0, Math.trunc(rawReworkCount))
      : 0;

  return Object.freeze({ path, stage, gate, sessionId, inbox: Object.freeze(items), reworkCount });
}

/**
 * Validate a raw WS frame against the pinned permission-request contract:
 * `{ type: 'permission-request', path: string, sessionId: string, requestId: string,
 *    toolUseId: string|null, toolName: string, title: string|null, input: string }`.
 * Returns a frozen PermissionRequest, or null for anything malformed.
 */
function parsePermissionRequest(data: unknown): PermissionRequest | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'permission-request') return null;

  const { path, sessionId, requestId, toolUseId, toolName, title, input } = frame;

  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  if (toolUseId !== null && typeof toolUseId !== 'string') return null;
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  if (title !== null && typeof title !== 'string') return null;
  if (typeof input !== 'string') return null;

  return Object.freeze({ path, sessionId, requestId, toolUseId, toolName, title, input });
}

/**
 * Validate a raw WS frame against the pinned foreign-session needs-you contract:
 * `{ type: 'foreign-session-needs-you', path: string, sessionId: string,
 *    kind: 'permission_prompt'|'idle_prompt'|'agent_needs_input', reason: string,
 *    ts: <finite number>, cleared: boolean }`.
 * Returns a frozen ForeignNeedsYou, or null for anything malformed.
 */
function parseForeignNeedsYou(data: unknown): ForeignNeedsYou | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'foreign-session-needs-you') return null;

  const { path, sessionId, kind, reason, ts, cleared } = frame;

  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (kind !== 'permission_prompt' && kind !== 'idle_prompt' && kind !== 'agent_needs_input') {
    return null;
  }
  if (typeof reason !== 'string') return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (typeof cleared !== 'boolean') return null;

  return Object.freeze({ path, sessionId, kind, reason, ts, cleared });
}

/**
 * Validate a raw WS frame against the pinned hook-bus liveness contract:
 * `{ type: 'hook-bus-liveness', connected: boolean, lastReceivedAt: <finite number>|null }`.
 * Returns a frozen HookBusLiveness, or null for anything malformed.
 */
function parseHookBusLiveness(data: unknown): HookBusLiveness | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'hook-bus-liveness') return null;

  const { connected, lastReceivedAt } = frame;

  if (typeof connected !== 'boolean') return null;
  if (
    lastReceivedAt !== null &&
    (typeof lastReceivedAt !== 'number' || !Number.isFinite(lastReceivedAt))
  ) {
    return null;
  }

  return Object.freeze({ connected, lastReceivedAt });
}

/**
 * Validate a raw WS frame against the pinned cost-usage contract:
 * `{ type: 'cost-usage', costTodayUsd: <finite number>, inputTokensToday: <finite number>,
 *    outputTokensToday: <finite number>, sinceEpochMs: <finite number> }`.
 * Returns a frozen CostUsage, or null for anything malformed.
 */
function parseCostUsage(data: unknown): CostUsage | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type !== 'cost-usage') return null;

  const { costTodayUsd, inputTokensToday, outputTokensToday, sinceEpochMs } = frame;

  if (typeof costTodayUsd !== 'number' || !Number.isFinite(costTodayUsd)) return null;
  if (typeof inputTokensToday !== 'number' || !Number.isFinite(inputTokensToday)) return null;
  if (typeof outputTokensToday !== 'number' || !Number.isFinite(outputTokensToday)) return null;
  if (typeof sinceEpochMs !== 'number' || !Number.isFinite(sinceEpochMs)) return null;

  return Object.freeze({ costTodayUsd, inputTokensToday, outputTokensToday, sinceEpochMs });
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
  const sessionPersonasListeners = new Set<SessionPersonasListener>();
  const workItemSessionsListeners = new Set<WorkItemSessionsListener>();
  const sessionTranscriptListeners = new Set<SessionTranscriptListener>();
  const bridgeStateListeners = new Set<BridgeStateListener>();
  const permissionRequestListeners = new Set<PermissionRequestListener>();
  const foreignNeedsYouListeners = new Set<ForeignNeedsYouListener>();
  const hookBusLivenessListeners = new Set<HookBusLivenessListener>();
  const costUsageListeners = new Set<CostUsageListener>();
  const rosterTimelineListeners = new Set<RosterTimelineListener>();

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

  function emitSessionPersonas(path: string, personas: readonly SessionPersona[]): void {
    for (const listener of sessionPersonasListeners) listener(path, personas);
  }

  function emitWorkItemSessions(
    path: string,
    workItemId: string,
    sessions: readonly WorkItemSessionAnchor[],
  ): void {
    for (const listener of workItemSessionsListeners) listener(path, workItemId, sessions);
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

  function emitPermissionRequest(request: PermissionRequest): void {
    for (const listener of permissionRequestListeners) listener(request);
  }

  function emitForeignNeedsYou(item: ForeignNeedsYou): void {
    for (const listener of foreignNeedsYouListeners) listener(item);
  }

  function emitHookBusLiveness(hookBusLiveness: HookBusLiveness): void {
    for (const listener of hookBusLivenessListeners) listener(hookBusLiveness);
  }

  function emitCostUsage(usage: CostUsage): void {
    for (const listener of costUsageListeners) listener(usage);
  }

  function emitRosterTimeline(path: string, timeline: RosterTimeline): void {
    for (const listener of rosterTimelineListeners) listener(path, timeline);
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

    if (type === 'session-personas') {
      const snapshot = parseSessionPersonasSnapshot(data);
      if (snapshot === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitSessionPersonas(snapshot.path, snapshot.personas);
      return;
    }

    if (type === 'work-item-sessions') {
      const snapshot = parseWorkItemSessionsSnapshot(data);
      if (snapshot === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitWorkItemSessions(snapshot.path, snapshot.workItemId, snapshot.sessions);
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

    if (type === 'permission-request') {
      const request = parsePermissionRequest(data);
      if (request === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitPermissionRequest(request);
      return;
    }

    if (type === 'foreign-session-needs-you') {
      const item = parseForeignNeedsYou(data);
      if (item === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitForeignNeedsYou(item);
      return;
    }

    if (type === 'hook-bus-liveness') {
      const hookBusLiveness = parseHookBusLiveness(data);
      if (hookBusLiveness === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitHookBusLiveness(hookBusLiveness);
      return;
    }

    if (type === 'cost-usage') {
      const usage = parseCostUsage(data);
      if (usage === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitCostUsage(usage);
      return;
    }

    if (type === 'roster-timeline') {
      const timeline = parseRosterTimelineSnapshot(data);
      if (timeline === null) {
        console.warn('[ws-client] dropped malformed frame:', data);
        return;
      }
      emitRosterTimeline(timeline.path, timeline);
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
    sessionPersonasListeners.clear();
    workItemSessionsListeners.clear();
    sessionTranscriptListeners.clear();
    bridgeStateListeners.clear();
    permissionRequestListeners.clear();
    foreignNeedsYouListeners.clear();
    hookBusLivenessListeners.clear();
    costUsageListeners.clear();
    rosterTimelineListeners.clear();

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

  function requestSessionPersonas(path: string): void {
    sendFrame({ type: 'session-personas', path });
  }

  function requestRosterTimeline(path: string): void {
    sendFrame({ type: 'roster-timeline', path });
  }

  function requestWorkItemSessions(path: string, workItemId: string): void {
    sendFrame({ type: 'work-item-sessions-request', path, workItemId });
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

  function sendPermissionDecision(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'allow-always',
  ): void {
    sendFrame({ type: 'permission-decision', sessionId, requestId, decision });
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
    onSessionPersonas: (listener) => {
      sessionPersonasListeners.add(listener);
      return () => {
        sessionPersonasListeners.delete(listener);
      };
    },
    onWorkItemSessions: (listener) => {
      workItemSessionsListeners.add(listener);
      return () => {
        workItemSessionsListeners.delete(listener);
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
    onPermissionRequest: (listener) => {
      permissionRequestListeners.add(listener);
      return () => {
        permissionRequestListeners.delete(listener);
      };
    },
    onForeignNeedsYou: (listener) => {
      foreignNeedsYouListeners.add(listener);
      return () => {
        foreignNeedsYouListeners.delete(listener);
      };
    },
    onHookBusLiveness: (listener) => {
      hookBusLivenessListeners.add(listener);
      return () => {
        hookBusLivenessListeners.delete(listener);
      };
    },
    onCostUsage: (listener) => {
      costUsageListeners.add(listener);
      return () => {
        costUsageListeners.delete(listener);
      };
    },
    onRosterTimeline: (listener) => {
      rosterTimelineListeners.add(listener);
      return () => {
        rosterTimelineListeners.delete(listener);
      };
    },
    pin,
    unpin,
    discover,
    requestGitState,
    requestTrackerState,
    requestLifecycleSignals,
    requestSessionPersonas,
    requestRosterTimeline,
    requestWorkItemSessions,
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
}
