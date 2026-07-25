// Integration test — HTTP Host-header loopback gate on the prod static server.
//
// The prod HTTP handler serves index.html carrying the INJECTED WS token, so it
// must refuse any request whose Host is not loopback — the HTTP-side twin of the
// WS Origin gate, closing a DNS-rebinding hole (a page that rebinds evil.com →
// 127.0.0.1 could otherwise fetch('/') same-origin and read the token).
//
// This asserts the gate's observable outcome by booting the REAL server with the
// PROD static handler active and issuing raw HTTP GETs with forged Host headers:
//   - Host: evil.example         → 403, body does NOT contain the token meta
//   - Host: 127.0.0.1:<port>     → 200, body DOES contain the token meta
//
// The prod static handler is gated on `PROD` (NODE_ENV=production), resolved at
// config import time. We set NODE_ENV BEFORE the dynamic import of the server so
// config resolves PROD=true; static ESM imports are hoisted and would evaluate
// config first, so createServer is imported dynamically inside beforeAll.

process.env.NODE_ENV = 'production';

import http from 'node:http';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TOKEN_META_MARKER = 'devos-ws-token';

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

// Issue a raw HTTP GET to 127.0.0.1:<port>/ with an explicit (possibly forged)
// Host header, resolving the status + full body.
function httpGet(port: number, hostHeader: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host: hostHeader } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface DevOsServerLike {
  readonly start: () => Promise<AddressInfo>;
  readonly stop: () => Promise<void>;
}

describe('HTTP Host-header loopback gate (prod static server)', () => {
  let instance: DevOsServerLike;
  let port: number;
  let dbPath: string;

  beforeAll(async () => {
    const { createServer } = await import('../../src/index.js');
    dbPath = join(tmpdir(), `devos-httphost-${randomUUID()}.db`);
    // requireToken:true forces the prod gate semantics; the minted token is hex.
    instance = createServer({ port: 0, dbPath, projectRoots: [], requireToken: true });
    const address = await instance.start();
    port = address.port;
  });

  afterAll(async () => {
    await instance.stop();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it('rejects a forged non-loopback Host with 403 and serves no token', async () => {
    const res = await httpGet(port, 'evil.example');

    expect(res.status).toBe(403);
    expect(res.body).not.toContain(TOKEN_META_MARKER);
  });

  it('serves the token-bearing index to a loopback Host with 200', async () => {
    const res = await httpGet(port, `127.0.0.1:${port}`);

    expect(res.status).toBe(200);
    expect(res.body).toContain(TOKEN_META_MARKER);
  });
});
