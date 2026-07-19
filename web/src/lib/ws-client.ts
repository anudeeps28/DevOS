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

/** The slice of the WebSocket API this client depends on (keeps fakes tiny). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null;
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

/** Public, framework-agnostic client surface. */
export interface WsClient {
  readonly getStatus: () => ConnectionStatus;
  /** Subscribe to status changes; the current status is emitted immediately. */
  readonly onStatus: (listener: StatusListener) => () => void;
  /** Subscribe to validated heartbeats. */
  readonly onHeartbeat: (listener: HeartbeatListener) => () => void;
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

  function detach(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
  }

  function handleMessage(data: unknown): void {
    const heartbeat = parseHeartbeat(data);
    if (heartbeat === null) {
      // Never throw into the app — drop and warn.
      console.warn('[ws-client] dropped malformed frame:', data);
      return;
    }
    emitHeartbeat(heartbeat);
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
    close,
  };
}
