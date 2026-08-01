// Hook HTTP handler — POST sink for the Claude Code hook forwarder. Enforces
// the boundary checks (method, loopback host, size cap, defensive JSON parse)
// and hands validated payloads to the HookBus. Never throws out of the
// handler and never lets this endpoint act as a path-existence / gate-outcome
// oracle: any readable loopback POST — valid, malformed, or dropped by the
// bus — gets a uniform 204.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HookBus } from './hook-bus.js';
import { isLoopbackHost } from '../ws-auth.js';
import { MAX_HOOK_PAYLOAD_BYTES } from '../config.js';

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

function respondOnce(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
): void {
  if (res.headersSent) return;
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  onComplete: (body: string) => void,
): void {
  let totalBytes = 0;
  const chunks: Buffer[] = [];
  let aborted = false;

  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > MAX_HOOK_PAYLOAD_BYTES) {
      aborted = true;
      req.destroy();
      respondOnce(
        res,
        413,
        { 'content-type': 'text/plain; charset=utf-8' },
        'Payload Too Large',
      );
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    onComplete(Buffer.concat(chunks).toString('utf8'));
  });

  req.on('error', () => {
    if (aborted) return;
    aborted = true;
    respondOnce(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad Request');
  });
}

/**
 * Create the `/hooks` POST handler. Only method (405), host (403), and
 * oversize (413) get distinct statuses — every other readable loopback POST
 * (valid JSON, malformed JSON, or a payload the bus silently drops) responds
 * a uniform 204 so the endpoint can never be used to probe gate outcomes.
 */
export function createHookHandler(deps: { hookBus: HookBus }): RequestHandler {
  return (req, res) => {
    try {
      if (req.method !== 'POST') {
        respondOnce(
          res,
          405,
          { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' },
          'Method Not Allowed',
        );
        return;
      }

      if (!isLoopbackHost(req.headers.host)) {
        console.warn('[hooks] rejected — host', req.headers.host);
        respondOnce(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'Forbidden');
        return;
      }

      readBody(req, res, (rawBody) => {
        try {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            respondOnce(res, 204, {}, '');
            return;
          }
          deps.hookBus.ingest(parsed);
          respondOnce(res, 204, {}, '');
        } catch (err) {
          console.error('[hooks] unexpected error handling body', err);
          respondOnce(res, 204, {}, '');
        }
      });
    } catch (err) {
      console.error('[hooks] unexpected error', err);
      respondOnce(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
    }
  };
}
