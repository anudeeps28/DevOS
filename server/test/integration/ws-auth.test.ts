// Integration test — WebSocket auth gate (AC2) over the live WS transport.
//
// Boots the REAL server in-process on a free port (PORT=0) with the connection
// gate FORCE-ENABLED (`authToken: 'test-secret-token', requireToken: true`), then
// opens raw `ws` handshakes and asserts the gate's observable outcome:
//   - foreign origin + valid token           → rejected, ZERO frames
//   - valid origin + NO token subprotocol     → rejected, ZERO frames
//   - valid origin + garbage token            → rejected, ZERO frames
//   - valid origin + valid token              → accepted, at least one server frame
//
// The token rides as a `token.<hex>` subprotocol entry alongside the fixed
// `devos` subprotocol, mirroring the browser client. A `verifyClient=false`
// rejection yields an HTTP 401 at the upgrade and delivers no frames — the raw
// `ws` client surfaces that as an 'error'/'unexpected-response'/close-before-open,
// so the helper treats any of those as 'rejected'.
//
// Isolation: PORT=0 + a per-test tmp SQLite file (never the real app-data DB), no
// project roots. afterEach stops the server and removes the .db/.db-wal/.db-shm
// sidecars.

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';

// Must be a lowercase hex string — resolveAuthToken now rejects non-hex tokens.
const AUTH_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SUBPROTOCOL = 'devos';
const VALID_ORIGIN_HOST = 'http://127.0.0.1';
const FOREIGN_ORIGIN = 'http://evil.example';

// The outcome of a single raw handshake attempt.
interface HandshakeOutcome {
  /** 'accepted' iff the socket reached 'open'; 'rejected' on any failure path. */
  readonly result: 'accepted' | 'rejected';
  /** True iff at least one server frame was received before resolution. */
  readonly receivedFrame: boolean;
}

/**
 * Open a raw `ws` handshake and resolve its observable outcome. Resolves
 * 'accepted' on 'open' (after briefly awaiting the first frame so the positive
 * case can prove a frame arrives), or 'rejected' on 'error' /
 * 'unexpected-response' / a close that precedes 'open', or on timeout.
 *
 * A 'message' listener flips `receivedFrame` so a rejection can be asserted to
 * have delivered ZERO frames.
 */
function attemptHandshake(
  url: string,
  protocols: string[],
  origin: string,
  timeoutMs = 4000,
): Promise<HandshakeOutcome> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, protocols, { origin });
    let settled = false;
    let opened = false;
    let receivedFrame = false;

    const settle = (result: 'accepted' | 'rejected'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      // Swallow any late error the teardown itself emits (e.g. terminating a
      // socket whose handshake never completed).
      socket.on('error', () => undefined);
      // terminate() is safe in every readyState (CONNECTING/OPEN/CLOSING);
      // close() throws "closed before the connection was established" while
      // still CONNECTING, which is exactly the rejection path.
      socket.terminate();
      resolve({ result, receivedFrame });
    };

    const timer = setTimeout(() => {
      // No 'open' and no failure in time → treat as rejected (nothing arrived).
      settle(opened ? 'accepted' : 'rejected');
    }, timeoutMs);

    socket.on('message', () => {
      receivedFrame = true;
      // On the accepted path, one frame is enough to prove the stream is live.
      if (opened) {
        settle('accepted');
      }
    });

    socket.on('open', () => {
      opened = true;
      // Give the server a brief window to push its first frame (registry /
      // heartbeat), then resolve 'accepted' regardless.
      setTimeout(() => settle('accepted'), 500);
    });

    // verifyClient=false surfaces here as 'error' / 'unexpected-response'.
    socket.on('error', () => settle('rejected'));
    socket.on('unexpected-response', () => settle('rejected'));
    socket.on('close', () => settle(opened ? 'accepted' : 'rejected'));
  });
}

interface RunningServer {
  readonly url: string;
  readonly validOrigin: string;
  readonly stop: () => Promise<void>;
}

const activeStops: Array<() => Promise<void>> = [];
const tmpDbPaths: string[] = [];

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-wsauth-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

async function startGatedServer(): Promise<RunningServer> {
  const dbPath = makeTmpDbPath();
  const instance = createServer({
    port: 0,
    dbPath,
    projectRoots: [],
    authToken: AUTH_TOKEN,
    requireToken: true,
  });
  const address: AddressInfo = await instance.start();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await instance.stop();
  };
  activeStops.push(stop);
  return {
    url: `ws://127.0.0.1:${address.port}${WS_PATH}`,
    validOrigin: `${VALID_ORIGIN_HOST}:${address.port}`,
    stop,
  };
}

afterEach(async () => {
  for (const stop of activeStops.splice(0)) {
    await stop().catch(() => undefined);
  }
  for (const path of tmpDbPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

describe('WebSocket auth gate (AC2) over the live WS transport', () => {
  it('rejects a foreign origin even with a valid token — no frame delivered', async () => {
    const server = await startGatedServer();

    const outcome = await attemptHandshake(
      server.url,
      [SUBPROTOCOL, `token.${AUTH_TOKEN}`],
      FOREIGN_ORIGIN,
    );

    expect(outcome.result).toBe('rejected');
    expect(outcome.receivedFrame).toBe(false);

    await server.stop();
  }, 15000);

  it('rejects a valid origin with NO token subprotocol — no frame delivered', async () => {
    const server = await startGatedServer();

    const outcome = await attemptHandshake(server.url, [SUBPROTOCOL], server.validOrigin);

    expect(outcome.result).toBe('rejected');
    expect(outcome.receivedFrame).toBe(false);

    await server.stop();
  }, 15000);

  it('rejects a valid origin with a garbage token — no frame delivered', async () => {
    const server = await startGatedServer();

    const outcome = await attemptHandshake(
      server.url,
      [SUBPROTOCOL, 'token.deadbeef'],
      server.validOrigin,
    );

    expect(outcome.result).toBe('rejected');
    expect(outcome.receivedFrame).toBe(false);

    await server.stop();
  }, 15000);

  it('accepts a valid origin + valid token and delivers a server frame', async () => {
    const server = await startGatedServer();

    const outcome = await attemptHandshake(
      server.url,
      [SUBPROTOCOL, `token.${AUTH_TOKEN}`],
      server.validOrigin,
    );

    expect(outcome.result).toBe('accepted');
    expect(outcome.receivedFrame).toBe(true);

    await server.stop();
  }, 15000);
});
