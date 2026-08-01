// DevOS server entry — one http.Server that serves the built web app (prod) and
// accepts the WebSocket upgrade on the same origin/port. Binds loopback only.
//
// Exposes createServer() so integration tests can boot it in-process on a chosen
// port (or PORT=0). Also auto-starts when run as the entry: `node dist/index.js`.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { DB_PATH, HOOK_PATH, HOST, PORT, PROD, PROJECT_ROOTS, WS_PATH, assertLoopbackHost } from './config.js';
import { openDatabase } from './db/database.js';
import { createHookBus, type HookBus } from './hooks/hook-bus.js';
import { createHookHandler } from './hooks/hook-handler.js';
import { createRegistry, type Registry } from './registry/registry.js';
import { createBridge, type Bridge } from './session/bridge.js';
import { createSessionStore } from './session/session-store.js';
import { createSessionManager, type SessionManager } from './session/session-manager.js';
import type { QueryFn } from './session/session-engine.js';
import { createStaticHandler } from './static-server.js';
import { resolveAuthToken } from './ws-auth.js';
import { attachWsGateway } from './ws-gateway.js';

export interface CreateServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly dbPath?: string;
  readonly projectRoots?: readonly string[];
  readonly authToken?: string;
  readonly requireToken?: boolean;
  readonly allowedOrigins?: readonly string[];
  /** Engine seam override for the SessionManager — tests inject a fake `query`. */
  readonly query?: QueryFn;
}

export interface DevOsServer {
  readonly server: http.Server;
  readonly start: () => Promise<AddressInfo>;
  readonly stop: () => Promise<void>;
  /** The project registry — exposed so in-process tests can pin fixtures directly. */
  readonly registry: Registry;
  /** The session manager — exposed so in-process tests can inspect live sessions. */
  readonly sessionManager: SessionManager;
  /** The Bridge — exposed so integration tests can inspect pipeline runs. */
  readonly bridge: Bridge;
  /** The hook event bus — exposed so integration tests can inspect foreign-session events. */
  readonly hookBus: HookBus;
  /** The resolved local WS auth token (minted or supplied) — exposed for tests. */
  readonly authToken: string;
}

export function createServer(options?: CreateServerOptions): DevOsServer {
  // Re-assert the loopback invariant at the bind boundary — defense-in-depth so
  // an explicit `host` override can never escape the loopback allowlist, even
  // though the prod path (main()) always uses the already-validated config HOST.
  const host = assertLoopbackHost(options?.host ?? HOST);
  const port = options?.port ?? PORT;

  const db = openDatabase(options?.dbPath ?? DB_PATH);
  const registry = createRegistry(db);
  const sessionStore = createSessionStore(db);
  const sessionManager = createSessionManager({
    store: sessionStore,
    ...(options?.query !== undefined ? { query: options.query } : {}),
  });

  const bridge = createBridge({ sessionManager, registry });

  const authToken = resolveAuthToken(options?.authToken);
  const requireToken = options?.requireToken ?? PROD;

  const staticHandler = createStaticHandler({ authToken });

  // Hook event bus: foreign Claude sessions POST their hook events to HOOK_PATH.
  // Route the hook POST before the static handler (which 405s non-GET) so no
  // asset read happens on the hook path. The WS upgrade never reaches this
  // request handler — `ws` intercepts it on the server's 'upgrade' event.
  const hookBus = createHookBus();
  const hookHandler = createHookHandler({ hookBus });
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let pathname: string | null = null;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        pathname = null;
      }
      if (pathname === HOOK_PATH) {
        hookHandler(req, res);
        return;
      }
    }
    staticHandler(req, res);
  });
  const gateway = attachWsGateway(server, {
    registry,
    sessionManager,
    bridge,
    hookBus,
    projectRoots: options?.projectRoots ?? PROJECT_ROOTS,
    authToken,
    requireToken,
    ...(options?.allowedOrigins !== undefined ? { allowedOrigins: options.allowedOrigins } : {}),
  });

  const start = (): Promise<AddressInfo> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('error', onError);
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error(`Unexpected server address: ${String(address)}`));
          return;
        }
        resolve(address);
      });
    });

  const stop = async (): Promise<void> => {
    // Interrupt every live owned session before tearing down the transport + DB.
    await sessionManager.stopAll();
    await gateway.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
  };

  return { server, start, stop, registry, sessionManager, bridge, hookBus, authToken };
}

function registerShutdown(instance: DevOsServer): void {
  const shutdown = (signal: string): void => {
    console.log(`[devos] ${signal} received — shutting down gracefully`);
    instance
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[devos] error during shutdown', err);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  const instance = createServer();
  registerShutdown(instance);

  try {
    const address = await instance.start();
    console.log(
      `[devos] listening on http://${address.address}:${address.port} ` +
        `(loopback only · WebSocket on ${WS_PATH})`,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(
        `[devos] FATAL: ${HOST}:${PORT} is already in use. ` +
          `Stop the process using that port, or set a different PORT.`,
      );
    } else {
      console.error('[devos] FATAL: failed to start server', err);
    }
    process.exit(1);
  }
}

// Auto-start only when executed directly (not when imported by tests).
const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  void main();
}
