// DevOS server entry — one http.Server that serves the built web app (prod) and
// accepts the WebSocket upgrade on the same origin/port. Binds loopback only.
//
// Exposes createServer() so integration tests can boot it in-process on a chosen
// port (or PORT=0). Also auto-starts when run as the entry: `node dist/index.js`.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { DB_PATH, HOST, PORT, PROJECT_ROOTS, WS_PATH, assertLoopbackHost } from './config.js';
import { openDatabase } from './db/database.js';
import { createRegistry } from './registry/registry.js';
import { createStaticHandler } from './static-server.js';
import { attachWsGateway } from './ws-gateway.js';

export interface CreateServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly dbPath?: string;
  readonly projectRoots?: readonly string[];
}

export interface DevOsServer {
  readonly server: http.Server;
  readonly start: () => Promise<AddressInfo>;
  readonly stop: () => Promise<void>;
}

export function createServer(options?: CreateServerOptions): DevOsServer {
  // Re-assert the loopback invariant at the bind boundary — defense-in-depth so
  // an explicit `host` override can never escape the loopback allowlist, even
  // though the prod path (main()) always uses the already-validated config HOST.
  const host = assertLoopbackHost(options?.host ?? HOST);
  const port = options?.port ?? PORT;

  const db = openDatabase(options?.dbPath ?? DB_PATH);
  const registry = createRegistry(db);

  const staticHandler = createStaticHandler();
  const server = http.createServer((req, res) => staticHandler(req, res));
  const gateway = attachWsGateway(server, {
    registry,
    projectRoots: options?.projectRoots ?? PROJECT_ROOTS,
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
    await gateway.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
  };

  return { server, start, stop };
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
