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
export type WebSocketFactory = (url: string) => WebSocketLike;

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
}

export type StatusListener = (status: ConnectionStatus) => void;
export type HeartbeatListener = (heartbeat: Heartbeat) => void;
export type RegistryListener = (projects: readonly RegistryProject[]) => void;

/** Public, framework-agnostic client surface. */
export interface WsClient {
  readonly getStatus: () => ConnectionStatus;
  /** Subscribe to status changes; the current status is emitted immediately. */
  readonly onStatus: (listener: StatusListener) => () => void;
  /** Subscribe to validated heartbeats. */
  readonly onHeartbeat: (listener: HeartbeatListener) => () => void;
  /** Subscribe to validated registry snapshots. */
  readonly onRegistry: (listener: RegistryListener) => () => void;
  /** Pin a project by absolute path; no-op (warns) when the socket is not open. */
  readonly pin: (path: string, opts?: { displayName?: string; uiPrefs?: unknown }) => void;
  /** Unpin a project by absolute path; no-op (warns) when the socket is not open. */
  readonly unpin: (path: string) => void;
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

const defaultCreateWebSocket: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

function defaultUrl(): string {
  return `ws://${location.host}${WS_PATH}`;
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

  const statusListeners = new Set<StatusListener>();
  const heartbeatListeners = new Set<HeartbeatListener>();
  const registryListeners = new Set<RegistryListener>();

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

    const socket = createWebSocket(url);
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
    pin,
    unpin,
    close,
  };
}
