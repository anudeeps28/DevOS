// Static asset server for the built web/dist bundle.
//
// PROD: serve web/dist over HTTP (correct content types + SPA fallback to
// index.html). Guards against path traversal. Assets only — NO app data flows
// over HTTP; all application data flows over the WebSocket.
//
// DEV: return 404 with a handoff note — Vite serves the app and proxies /ws.

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROD } from './config.js';
import { isLoopbackHost } from './ws-auth.js';

// From server/dist/static-server.js -> repo/web/dist
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
const INDEX_HTML = path.join(WEB_DIST, 'index.html');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

// Resolve a request path to an absolute path inside WEB_DIST, or null if it
// would escape the root (path traversal).
function resolveAssetPath(urlPath: string): string | null {
  const relative = urlPath.replace(/^\/+/, '');
  const candidate = path.resolve(WEB_DIST, relative);
  if (candidate !== WEB_DIST && !candidate.startsWith(WEB_DIST + path.sep)) {
    return null;
  }
  return candidate;
}

// Pick the concrete file to serve: the requested file if it exists, else the
// SPA fallback (index.html).
async function pickFile(candidate: string): Promise<string> {
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) return candidate;
  } catch {
    // not found — fall through to SPA fallback
  }
  return INDEX_HTML;
}

// Serve index.html with the local WS auth token injected as a meta tag so the
// app's own page can read it and present it on the WS handshake. Reads the file
// to a string (small HTML entry), inserts the meta immediately before </head>,
// and recomputes content-length from the injected buffer's byte length. Token is
// hex (URL/HTML-safe) so no escaping is needed. Preserves HEAD (headers only).
async function sendIndexWithToken(
  res: ServerResponse,
  token: string,
  headOnly: boolean,
): Promise<void> {
  const html = await fs.readFile(INDEX_HTML, 'utf8');
  const meta = `<meta name="devos-ws-token" content="${token}">`;
  let injected: string;
  if (html.includes('</head>')) {
    injected = html.replace('</head>', `${meta}</head>`);
  } else {
    // The built entry is malformed — serve it, but make the failure diagnosable:
    // with no token the prod client dials the gate tokenless and is rejected.
    console.warn('[http] index.html has no </head> — WS token not injected; client will fail auth');
    injected = html;
  }
  const body = Buffer.from(injected, 'utf8');

  res.writeHead(200, {
    'content-type': contentTypeFor(INDEX_HTML),
    'content-length': body.byteLength,
    'cache-control': 'no-cache',
  });

  if (headOnly) {
    res.end();
    return;
  }
  res.end(body);
}

async function sendFile(
  res: ServerResponse,
  filePath: string,
  headOnly: boolean,
  authToken?: string,
): Promise<void> {
  // Index branch: when a token is provided, inject it into the served HTML
  // instead of streaming the file verbatim.
  if (filePath === INDEX_HTML && authToken !== undefined && authToken.length > 0) {
    try {
      await sendIndexWithToken(res, authToken, headOnly);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found — web/dist may not be built (run `npm run build`).');
    }
    return;
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found — web/dist may not be built (run `npm run build`).');
    return;
  }

  const isIndex = filePath === INDEX_HTML;
  res.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': stat.size,
    'cache-control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
  });

  if (headOnly) {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('[static] stream error', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end();
  });
  stream.pipe(res);
}

async function handleProd(
  req: IncomingMessage,
  res: ServerResponse,
  authToken?: string,
): Promise<void> {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    // Host-header loopback gate (DNS-rebinding defense): the prod entry serves
    // index.html carrying the injected WS token, so a non-loopback Host must never
    // be served — the HTTP-side twin of the WS Origin gate. Fails closed on a
    // missing/foreign Host (a missing Host header is rejected in prod).
    if (!isLoopbackHost(req.headers.host)) {
      console.warn('[http] rejected request — host', req.headers.host);
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const urlPath = decodeURIComponent(url.pathname);
    const resolved = resolveAssetPath(urlPath);
    if (resolved === null) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const filePath = await pickFile(resolved);
    await sendFile(res, filePath, req.method === 'HEAD', authToken);
  } catch (err) {
    console.error('[static] unexpected error', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal Server Error');
  }
}

function handleDev(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(
    'DevOS dev mode: static assets are served by Vite (http://127.0.0.1:5173). ' +
      'This Node server handles the /ws WebSocket only.',
  );
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export function createStaticHandler(options?: { authToken?: string }): RequestHandler {
  if (!PROD) {
    return handleDev;
  }
  const authToken = options?.authToken;
  return (req, res) => {
    void handleProd(req, res, authToken);
  };
}
