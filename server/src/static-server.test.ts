// Unit tests for the static asset handler — the one file with real branching:
// the path-traversal guard, method gating (405), the dev-mode handoff, and the
// prod content-type + SPA fallback. HTTP req/res are stubbed; the file-serving
// assertions run only when web/dist has been built.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// web/dist/index.html relative to this test file (server/src -> repo/web/dist).
const BUILT_INDEX = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url));
const isBuilt = existsSync(BUILT_INDEX);

interface StubRes {
  status: number;
  headers: Record<string, string | number>;
  body: string;
  ended: boolean;
  headersSent: boolean;
  writeHead: ServerResponse['writeHead'];
  end: ServerResponse['end'];
}

function makeReq(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

function makeRes(): StubRes {
  const res: StubRes = {
    status: 0,
    headers: {},
    body: '',
    ended: false,
    headersSent: false,
    writeHead: ((status: number, headers?: Record<string, string | number>) => {
      res.status = status;
      res.headers = headers ?? {};
      res.headersSent = true;
      return res as unknown as ServerResponse;
    }) as ServerResponse['writeHead'],
    end: ((chunk?: string) => {
      if (typeof chunk === 'string') res.body += chunk;
      res.ended = true;
      return res as unknown as ServerResponse;
    }) as ServerResponse['end'],
  };
  return res;
}

// The prod handler is async and dispatched via `void`; poll until it ends.
async function runUntilEnded(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  req: IncomingMessage,
  res: StubRes,
): Promise<void> {
  handler(req, res as unknown as ServerResponse);
  const deadline = Date.now() + 2_000;
  while (!res.ended) {
    if (Date.now() > deadline) throw new Error('handler did not end the response');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function importHandler(prod: boolean): Promise<() => (req: IncomingMessage, res: ServerResponse) => void> {
  vi.resetModules();
  if (prod) vi.stubEnv('NODE_ENV', 'production');
  else vi.stubEnv('NODE_ENV', 'development');
  const mod = await import('./static-server.js');
  return mod.createStaticHandler;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('static handler — dev mode', () => {
  it('returns a 404 handoff pointing at Vite (no assets served by Node in dev)', async () => {
    const createStaticHandler = await importHandler(false);
    const handler = createStaticHandler();
    const res = makeRes();
    handler(makeReq('GET', '/'), res as unknown as ServerResponse);
    expect(res.status).toBe(404);
    expect(res.body).toMatch(/Vite/);
  });
});

describe('static handler — prod mode', () => {
  let createStaticHandler: () => (req: IncomingMessage, res: ServerResponse) => void;

  beforeEach(async () => {
    createStaticHandler = await importHandler(true);
  });

  it('rejects non-GET/HEAD methods with 405 + Allow header', async () => {
    const handler = createStaticHandler();
    const res = makeRes();
    await runUntilEnded(handler, makeReq('POST', '/'), res);
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
  });

  it('blocks percent-encoded path traversal that escapes web/dist with 403', async () => {
    // Plain `..` is collapsed by URL normalization before the guard; the real
    // threat is percent-encoded `..` (%2e%2e), which decodes AFTER normalization
    // and would escape the root — the guard must catch it.
    // The slash must also be encoded (%2f) — otherwise `new URL` collapses the
    // `..` before the guard runs. These decode to `/../../etc/passwd`, which
    // resolves outside web/dist and must be refused.
    const handler = createStaticHandler();
    for (const bad of ['/%2e%2e%2f%2e%2e%2fetc/passwd', '/..%2f..%2fetc/passwd']) {
      const res = makeRes();
      await runUntilEnded(handler, makeReq('GET', bad), res);
      expect(res.status, `expected 403 for ${bad}`).toBe(403);
    }
  });

  it('normalizes plain ".." so it never serves a file outside web/dist', async () => {
    // `/../../package.json` normalizes to `/package.json` (inside root, absent) →
    // SPA fallback to index.html or 404 — never the real repo-root package.json.
    // Either way the response must not be application/json. HEAD avoids streaming.
    const handler = createStaticHandler();
    const res = makeRes();
    await runUntilEnded(handler, makeReq('HEAD', '/../../package.json'), res);
    expect(String(res.headers['content-type'] ?? '')).not.toMatch(/application\/json/);
  });

  it.skipIf(!isBuilt)('serves index.html with an html content-type (HEAD)', async () => {
    const handler = createStaticHandler();
    const res = makeRes();
    await runUntilEnded(handler, makeReq('HEAD', '/index.html'), res);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/text\/html/);
  });

  it.skipIf(!isBuilt)('falls back to index.html for unknown SPA routes (HEAD)', async () => {
    const handler = createStaticHandler();
    const res = makeRes();
    await runUntilEnded(handler, makeReq('HEAD', '/some/spa/route'), res);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/text\/html/);
  });
});
