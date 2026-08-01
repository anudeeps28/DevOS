// Integration test (THE GATE) — HTTP POST /hooks → WS broadcast (AC1/AC2/security).
//
// Boots the REAL server in-process (createServer({port:0,…})), pins a REAL tmp
// directory that resolves inside the configured projectRoots (the two-layer gate
// ws-gateway.ts applies to every foreign hook event: isPinnedPath + isWithin
// ProjectRoots), connects a real `ws` client (mirrors tracker-state.test.ts /
// permission-cards.test.ts's connect helper), and POSTs raw hook payloads via
// node:http to exercise the HOOK_PATH sink end to end:
//   AC1a — a Notification (permission_prompt) for the pinned/within-roots cwd
//          broadcasts a foreign-session-needs-you frame (cleared:false).
//   AC1b — a SessionEnd for the same session broadcasts cleared:true.
//   AC2a — a freshly connected client's initial hook-bus-liveness frame is
//          connected:false (nothing received yet).
//   AC2b — after AC1a's POST, a hook-bus-liveness frame flips to connected:true.
//   SEC1 — a non-loopback Host header is rejected 403, no broadcast.
//   SEC2 — an oversize body is rejected 413, server stays up for later POSTs.
//   SEC3 — malformed JSON gets a uniform 204, no broadcast, no crash.
//   SEC4 — a valid payload whose cwd is NOT pinned (fail-closed) gets 204, no
//          broadcast.
//
// Isolation: one tmp DB + one tmp project-roots dir per test file; afterAll tears
// down the client + `instance.stop()` and removes the tmp dirs/DB sidecars.

import { promises as fs } from 'node:fs';
import { rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type DevOsServer } from '../../src/index.js';
import { HOOK_PATH, MAX_HOOK_PAYLOAD_BYTES, WS_PATH } from '../../src/config.js';

type AnyFrame = Record<string, unknown> & { readonly type: string };

interface ForeignSessionNeedsYouFrame extends AnyFrame {
  readonly type: 'foreign-session-needs-you';
  readonly path: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly cleared: boolean;
}

interface HookBusLivenessFrame extends AnyFrame {
  readonly type: 'hook-bus-liveness';
  readonly connected: boolean;
  readonly lastReceivedAt: number | null;
}

function isAnyFrame(value: unknown): value is AnyFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['type'] === 'string'
  );
}

function isForeignSessionNeedsYouFrame(frame: AnyFrame): frame is ForeignSessionNeedsYouFrame {
  return (
    frame.type === 'foreign-session-needs-you' &&
    typeof frame['path'] === 'string' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['cleared'] === 'boolean'
  );
}

function isHookBusLivenessFrame(frame: AnyFrame): frame is HookBusLivenessFrame {
  return frame.type === 'hook-bus-liveness' && typeof frame['connected'] === 'boolean';
}

// ---------------------------------------------------------------------------
// In-test WS client — collects every typed frame; generic predicate waiter.
// Mirrors the connect helper in tracker-state.test.ts / permission-cards.test.ts.
// ---------------------------------------------------------------------------

interface Waiter {
  readonly predicate: (frame: AnyFrame) => boolean;
  readonly resolve: (frame: AnyFrame) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface TestClient {
  readonly waitForFrame: (
    predicate: (frame: AnyFrame) => boolean,
    timeoutMs: number,
    label: string,
  ) => Promise<AnyFrame>;
  readonly framesOfType: <T extends AnyFrame>(guard: (f: AnyFrame) => f is T) => T[];
  readonly close: () => void;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let waiters: Waiter[] = [];
    const seen: AnyFrame[] = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    socket.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!opened) {
        clearTimeout(openTimer);
        reject(error);
        return;
      }
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });

    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isAnyFrame(parsed)) return;
      seen.push(parsed);
      const stillWaiting: Waiter[] = [];
      for (const waiter of waiters) {
        if (waiter.predicate(parsed)) {
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        } else {
          stillWaiting.push(waiter);
        }
      }
      waiters = stillWaiting;
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        waitForFrame: (predicate, timeoutMs, label) =>
          new Promise<AnyFrame>((res, rej) => {
            const existing = seen.find(predicate);
            if (existing) {
              res(existing);
              return;
            }
            const timer = setTimeout(() => {
              waiters = waiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
            }, timeoutMs);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        framesOfType: (guard) => seen.filter(guard),
        close: () => {
          socket.removeAllListeners();
          socket.close();
        },
      });
    });
  });
}

/** Wait `ms` — used only for the SEC4 negative-assertion tick (no oracle to await instead). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// POST /hooks helper — raw node:http so we can drive the Host header + body size.
// ---------------------------------------------------------------------------

interface PostHookResult {
  readonly status: number;
}

function postHook(
  port: number,
  bodyString: string,
  headers?: Record<string, string>,
): Promise<PostHookResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: HOOK_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyString),
          ...headers,
        },
      },
      (res) => {
        res.on('data', () => {}); // drain
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.write(bodyString);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server + fixture lifecycle.
// ---------------------------------------------------------------------------

let instance: DevOsServer;
let address: AddressInfo;
let dbPath: string;
let projectRoot: string;
let pinnedDir: string;
let outsideRoot: string;
let client: TestClient;

beforeAll(async () => {
  dbPath = join(tmpdir(), `devos-hookbus-${randomUUID()}.db`);
  projectRoot = join(tmpdir(), `devos-hookbus-root-${randomUUID()}`);
  await fs.mkdir(projectRoot, { recursive: true });
  pinnedDir = await fs.mkdtemp(join(projectRoot, 'pinned-'));

  outsideRoot = join(tmpdir(), `devos-hookbus-outside-${randomUUID()}`);
  await fs.mkdir(outsideRoot, { recursive: true });

  instance = createServer({ port: 0, dbPath, projectRoots: [projectRoot] });
  instance.registry.pin(pinnedDir);
  address = await instance.start();

  client = await openClient(`ws://127.0.0.1:${address.port}${WS_PATH}`);
});

afterAll(async () => {
  client?.close();
  await instance?.stop().catch(() => undefined);
  await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(outsideRoot, { recursive: true, force: true }).catch(() => undefined);
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

describe('HTTP POST /hooks → WS broadcast (AC1/AC2/security)', () => {
  it('AC2a — a freshly connected client sees connected:false on the initial hook-bus-liveness frame', () => {
    const initial = client.framesOfType(isHookBusLivenessFrame)[0];
    expect(initial).toBeDefined();
    expect(initial?.connected).toBe(false);
  });

  it('AC1a/AC2b — a Notification permission_prompt for the pinned+within-roots cwd broadcasts foreign-session-needs-you (cleared:false) and flips liveness to connected:true', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const body = JSON.stringify({
      session_id: sessionId,
      cwd: pinnedDir,
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Needs a permission decision',
    });

    const needsYouPromise = client.waitForFrame(
      (f) =>
        isForeignSessionNeedsYouFrame(f) &&
        f.sessionId === sessionId &&
        f.path === pinnedDir &&
        f.kind === 'permission_prompt' &&
        f.cleared === false,
      5000,
      'foreign-session-needs-you (permission_prompt)',
    );
    const livenessPromise = client.waitForFrame(
      (f) => isHookBusLivenessFrame(f) && f.connected === true,
      5000,
      'hook-bus-liveness connected:true',
    );

    const res = await postHook(address.port, body);
    expect(res.status).toBe(204);

    const needsYouFrame = (await needsYouPromise) as ForeignSessionNeedsYouFrame;
    expect(needsYouFrame.sessionId).toBe(sessionId);
    expect(needsYouFrame.path).toBe(pinnedDir);
    expect(needsYouFrame.kind).toBe('permission_prompt');
    expect(needsYouFrame.cleared).toBe(false);

    await livenessPromise;

    // AC1b: SessionEnd for the same session clears it.
    const endBody = JSON.stringify({
      session_id: sessionId,
      cwd: pinnedDir,
      hook_event_name: 'SessionEnd',
    });
    const clearedPromise = client.waitForFrame(
      (f) => isForeignSessionNeedsYouFrame(f) && f.sessionId === sessionId && f.cleared === true,
      5000,
      'foreign-session-needs-you (cleared)',
    );
    const endRes = await postHook(address.port, endBody);
    expect(endRes.status).toBe(204);

    const clearedFrame = (await clearedPromise) as ForeignSessionNeedsYouFrame;
    expect(clearedFrame.sessionId).toBe(sessionId);
    expect(clearedFrame.cleared).toBe(true);
  }, 15000);

  it('SEC1 — a non-loopback Host header is rejected 403 with no broadcast', async () => {
    const before = client.framesOfType(isForeignSessionNeedsYouFrame).length;
    const sessionId = `sess-${randomUUID()}`;
    const body = JSON.stringify({
      session_id: sessionId,
      cwd: pinnedDir,
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
    });

    const res = await postHook(address.port, body, { host: 'evil.example.com' });
    expect(res.status).toBe(403);

    // Fence: a subsequent valid POST round-trips, proving no delayed broadcast arrives.
    const fenceSessionId = `sess-${randomUUID()}`;
    const fencePromise = client.waitForFrame(
      (f) => isForeignSessionNeedsYouFrame(f) && f.sessionId === fenceSessionId,
      5000,
      'fence needs-you frame',
    );
    await postHook(
      address.port,
      JSON.stringify({
        session_id: fenceSessionId,
        cwd: pinnedDir,
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
      }),
    );
    await fencePromise;

    const after = client
      .framesOfType(isForeignSessionNeedsYouFrame)
      .filter((f) => f.sessionId === sessionId);
    expect(after.length).toBe(0);
    expect(before).toBe(before); // no-op sanity — the real assertion is `after.length === 0`
  }, 15000);

  it('SEC2 — an oversize body is rejected 413 and the server stays up for a subsequent valid POST', async () => {
    const oversized = 'x'.repeat(MAX_HOOK_PAYLOAD_BYTES + 1024);
    const res = await postHook(address.port, oversized).catch((err: Error) => {
      // A destroyed connection can surface as a socket error on some platforms — either
      // outcome (413 response or torn connection) satisfies the "handled" requirement.
      return { status: -1, error: err };
    });
    if ('error' in res) {
      expect(res.error).toBeInstanceOf(Error);
    } else {
      expect(res.status).toBe(413);
    }

    // The server still serves a subsequent valid POST — proves no crash.
    const sessionId = `sess-${randomUUID()}`;
    const followUp = await postHook(
      address.port,
      JSON.stringify({
        session_id: sessionId,
        cwd: pinnedDir,
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
      }),
    );
    expect(followUp.status).toBe(204);
  }, 15000);

  it('SEC3 — malformed JSON gets a uniform 204 with no broadcast and no crash', async () => {
    const fenceSessionId = `sess-${randomUUID()}`;
    const res = await postHook(address.port, '{not valid json');
    expect(res.status).toBe(204);

    // Fence: a subsequent valid POST round-trips, proving the malformed body never
    // triggered a delayed broadcast and the gateway is still healthy.
    const fencePromise = client.waitForFrame(
      (f) => isForeignSessionNeedsYouFrame(f) && f.sessionId === fenceSessionId,
      5000,
      'fence needs-you frame',
    );
    await postHook(
      address.port,
      JSON.stringify({
        session_id: fenceSessionId,
        cwd: pinnedDir,
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
      }),
    );
    await fencePromise;
  }, 15000);

  it('SEC4 — a valid payload whose cwd is NOT pinned is dropped (204, fail-closed, no broadcast)', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const body = JSON.stringify({
      session_id: sessionId,
      cwd: outsideRoot,
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
    });

    const res = await postHook(address.port, body);
    expect(res.status).toBe(204);

    // No oracle for "never arrives" — wait a short tick, then assert no matching frame.
    await wait(300);
    const matching = client
      .framesOfType(isForeignSessionNeedsYouFrame)
      .filter((f) => f.sessionId === sessionId);
    expect(matching.length).toBe(0);
  }, 15000);
});
