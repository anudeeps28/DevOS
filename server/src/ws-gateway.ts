// WebSocket gateway — the sole browser<->server *data* transport.
//
// Attaches a `ws` WebSocketServer to the shared http.Server on WS_PATH. Each
// connected client gets its own heartbeat pump; sends are guarded against
// non-OPEN sockets.
//
// NOTE: origin check / local token is intentionally OUT of scope here — it is
// deferred to the M1 "Projects Grid + localhost security" task. Do NOT add it.

import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { HEARTBEAT_INTERVAL_MS, WS_PATH } from './config.js';
import { scanCandidates } from './discovery/scanner.js';
import { readGitState } from './git/git-state-reader.js';
import { createHeartbeat, type HeartbeatMessage } from './heartbeat.js';
import { readLifecycleSignals } from './lifecycle/lifecycle-reader.js';
import type { Registry } from './registry/registry.js';
import { readTrackerState } from './tracker/tracker-reader.js';
import {
  MAX_WS_PAYLOAD_BYTES,
  parseInboundMessage,
  type OutboundMessage,
} from './ws-protocol.js';

/** Every frame the gateway is allowed to push over the wire. */
type ServerFrame = HeartbeatMessage | OutboundMessage;

// Minimum interval between two `discover` scans on the SAME socket. Discovery is
// filesystem I/O and the client auto-discovers on every (re)connect, so a flapping
// connection or a spammed frame would otherwise re-scan repeatedly. Repeats inside
// this window are dropped (the client already has, or is about to get, a snapshot).
const DISCOVER_MIN_INTERVAL_MS = 500;

// Minimum interval between two `git-state` reads on the SAME socket. This is a
// FLOOD-GUARD ONLY, never a cache: every accepted request always does a fresh
// `readGitState` read — git state is never memoized server-side. The window only
// drops rapid-fire repeats on a single socket.
const GIT_STATE_MIN_INTERVAL_MS = 200;

// Minimum interval between two `tracker-state` reads on the SAME socket. This is a
// FLOOD-GUARD ONLY, never a cache: every accepted request always does a fresh
// `readTrackerState` read — tracker state is never memoized server-side. The window
// only drops rapid-fire repeats on a single socket.
const TRACKER_STATE_MIN_INTERVAL_MS = 200;

// Minimum interval between two `lifecycle-signals` reads on the SAME socket. This is
// a FLOOD-GUARD ONLY, never a cache: every accepted request always does a fresh
// `readLifecycleSignals` read — never memoized server-side (ARCHITECTURE §9.2: derived
// live per render). The window only drops rapid-fire repeats on a single socket.
const LIFECYCLE_SIGNALS_MIN_INTERVAL_MS = 200;

export interface WsGatewayOptions {
  readonly intervalMs?: number;
  readonly registry: Registry;
  readonly projectRoots: readonly string[];
}

export interface WsGateway {
  readonly wss: WebSocketServer;
  readonly close: () => Promise<void>;
}

function sendFrame(socket: WebSocket, message: ServerFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return; // guard: never send on a closing/closed socket
  try {
    socket.send(JSON.stringify(message));
  } catch (err) {
    console.error('[ws] failed to send frame', err);
  }
}

export function attachWsGateway(server: Server, options: WsGatewayOptions): WsGateway {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const { registry } = options;

  // `ws` handles the HTTP upgrade itself, filtered to WS_PATH. maxPayload caps the
  // per-frame size (ws defaults to 100 MiB) so a client can't push huge blobs.
  const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: MAX_WS_PAYLOAD_BYTES });

  // Build a fresh registry snapshot and push it to every OPEN client so multiple
  // browser tabs stay in sync after any mutation. Reading the registry is guarded
  // — a read failure must never crash the gateway.
  const broadcastRegistry = (): void => {
    let snapshot: OutboundMessage;
    try {
      snapshot = { type: 'registry', projects: registry.listProjects() };
    } catch (err) {
      console.error('[ws] failed to read registry for broadcast', err);
      return;
    }
    for (const client of wss.clients) {
      sendFrame(client, snapshot);
    }
  };

  // Access control (A01): the per-path read frames (git-state, tracker-state,
  // lifecycle-signals) drive FS + git + adapter subprocesses at a client-supplied
  // path. Restrict every read to a currently PINNED project so a client cannot probe
  // arbitrary host directories (a file-existence oracle + subprocess spawning). A read
  // failure while checking the registry fails CLOSED (deny). This is the per-request
  // path-ownership control; the WS Origin/token CONNECTION gate is tracked separately
  // (6h6hMMj3PX4Gjcr8).
  const isPinnedPath = (path: string): boolean => {
    try {
      return registry.listProjects().some((project) => project.path === path);
    } catch (err) {
      console.error('[ws] registry read failed during path-allowlist check', err);
      return false;
    }
  };

  wss.on('connection', (socket: WebSocket) => {
    console.log('[ws] client connected');

    // Per-socket throttle for `discover` — see DISCOVER_MIN_INTERVAL_MS.
    let lastDiscoverAt = 0;

    // Per-socket, per-PATH flood-guard for `git-state` — see
    // GIT_STATE_MIN_INTERVAL_MS. Keyed by path (not a single scalar) because a
    // client fans out one request per pinned project in a burst: a per-socket
    // scalar would drop every project after the first. This only drops rapid
    // repeats of the SAME path on the same socket.
    const lastGitStateAt = new Map<string, number>();

    // Per-socket, per-PATH flood-guard for `tracker-state` — see
    // TRACKER_STATE_MIN_INTERVAL_MS. Keyed by path (not a single scalar) because a
    // client fans out one request per pinned project in a burst: a per-socket
    // scalar would drop every project after the first. This only drops rapid
    // repeats of the SAME path on the same socket.
    const lastTrackerStateAt = new Map<string, number>();

    // Per-socket, per-PATH flood-guard for `lifecycle-signals` — see
    // LIFECYCLE_SIGNALS_MIN_INTERVAL_MS. Keyed by path (not a single scalar) because a
    // single socket fans out one read per pinned project; a per-socket scalar would
    // drop the fan-out.
    const lastLifecycleSignalsAt = new Map<string, number>();

    const heartbeat = createHeartbeat({
      intervalMs,
      emit: (message) => sendFrame(socket, message),
    });
    heartbeat.start();

    // Send an initial snapshot so a freshly-connected client renders current
    // state without waiting for a mutation.
    try {
      sendFrame(socket, { type: 'registry', projects: registry.listProjects() });
    } catch (err) {
      console.error('[ws] failed to send initial registry snapshot', err);
    }

    socket.on('message', async (data) => {
      // Boundary: validate every inbound frame; malformed input is dropped, never thrown.
      const message = parseInboundMessage(data.toString());
      if (message === null) {
        console.warn('[ws] dropped malformed inbound frame');
        return;
      }

      // Discovery scan: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a scan/read failure never crashes the gateway.
      if (message.type === 'discover') {
        // Throttle: drop repeats within the min-interval on this socket.
        const now = Date.now();
        if (now - lastDiscoverAt < DISCOVER_MIN_INTERVAL_MS) return;
        lastDiscoverAt = now;

        try {
          const pinnedPaths = new Set(registry.listProjects().map((p) => p.path));
          const candidates = await scanCandidates(options.projectRoots, pinnedPaths);
          sendFrame(socket, { type: 'candidates', candidates });
        } catch (err) {
          console.error('[ws] discovery scan failed', err);
          // Send an empty snapshot so the client isn't left hanging.
          sendFrame(socket, { type: 'candidates', candidates: [] });
        }
        return;
      }

      // Git-state read: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a read failure never crashes the gateway.
      if (message.type === 'git-state') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME path within the min-interval on
        // this socket. Distinct paths (the per-project fan-out) always pass.
        const now = Date.now();
        const last = lastGitStateAt.get(message.path) ?? 0;
        if (now - last < GIT_STATE_MIN_INTERVAL_MS) return;
        lastGitStateAt.set(message.path, now);

        try {
          const state = await readGitState(message.path);
          sendFrame(socket, { type: 'git-state', path: message.path, state });
        } catch (err) {
          console.error('[ws] git-state read failed', err);
        }
        return;
      }

      // Tracker-state read: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a read failure never crashes the gateway.
      if (message.type === 'tracker-state') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME path within the min-interval on
        // this socket. Distinct paths (the per-project fan-out) always pass.
        const now = Date.now();
        const last = lastTrackerStateAt.get(message.path) ?? 0;
        if (now - last < TRACKER_STATE_MIN_INTERVAL_MS) return;
        lastTrackerStateAt.set(message.path, now);

        try {
          const state = await readTrackerState(message.path);
          sendFrame(socket, { type: 'tracker-state', path: message.path, state });
        } catch (err) {
          console.error('[ws] tracker-state read failed', err);
        }
        return;
      }

      if (message.type === 'lifecycle-signals') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME path within the min-interval on
        // this socket. Distinct paths (the per-project fan-out) always pass.
        const now = Date.now();
        const last = lastLifecycleSignalsAt.get(message.path) ?? 0;
        if (now - last < LIFECYCLE_SIGNALS_MIN_INTERVAL_MS) return;
        lastLifecycleSignalsAt.set(message.path, now);

        try {
          const signals = await readLifecycleSignals(message.path);
          sendFrame(socket, {
            type: 'lifecycle-signals',
            path: message.path,
            state: { path: message.path, signals },
          });
        } catch (err) {
          console.error('[ws] lifecycle-signals read failed', err);
        }
        return;
      }

      try {
        if (message.type === 'pin') {
          registry.pin(message.path, {
            // Conditional spreads keep optional fields absent (never `undefined`)
            // so the call satisfies exactOptionalPropertyTypes.
            ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
            ...('uiPrefs' in message ? { uiPrefs: message.uiPrefs } : {}),
          });
        } else {
          registry.unpin(message.path);
        }
        broadcastRegistry();
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        console.error(`[ws] registry ${message.type} failed`, err);
        sendFrame(socket, {
          type: 'registry:error',
          op: message.type,
          path: message.path,
          message: errMessage,
        });
      }
    });

    socket.on('close', () => {
      console.log('[ws] client disconnected');
      heartbeat.stop();
    });

    socket.on('error', (err) => {
      console.error('[ws] client socket error', err);
      heartbeat.stop();
    });
  });

  wss.on('error', (err) => {
    console.error('[ws] server error', err);
  });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch (err) {
          console.error('[ws] error terminating client', err);
        }
      }
      wss.close(() => resolve());
    });

  return { wss, close };
}
