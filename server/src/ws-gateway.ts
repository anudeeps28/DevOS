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
import { createHeartbeat, type HeartbeatMessage } from './heartbeat.js';

export interface WsGatewayOptions {
  readonly intervalMs?: number;
}

export interface WsGateway {
  readonly wss: WebSocketServer;
  readonly close: () => Promise<void>;
}

function sendFrame(socket: WebSocket, message: HeartbeatMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return; // guard: never send on a closing/closed socket
  try {
    socket.send(JSON.stringify(message));
  } catch (err) {
    console.error('[ws] failed to send frame', err);
  }
}

export function attachWsGateway(server: Server, options?: WsGatewayOptions): WsGateway {
  const intervalMs = options?.intervalMs ?? HEARTBEAT_INTERVAL_MS;

  // `ws` handles the HTTP upgrade itself, filtered to WS_PATH.
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on('connection', (socket: WebSocket) => {
    console.log('[ws] client connected');

    const heartbeat = createHeartbeat({
      intervalMs,
      emit: (message) => sendFrame(socket, message),
    });
    heartbeat.start();

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
