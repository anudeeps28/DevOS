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
import { createHeartbeat, type HeartbeatMessage } from './heartbeat.js';
import type { Registry } from './registry/registry.js';
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

  wss.on('connection', (socket: WebSocket) => {
    console.log('[ws] client connected');

    // Per-socket throttle for `discover` — see DISCOVER_MIN_INTERVAL_MS.
    let lastDiscoverAt = 0;

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
