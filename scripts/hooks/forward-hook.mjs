#!/usr/bin/env node
// Forwards a Claude Code hook event (raw JSON on stdin) to the DevOS server's
// loopback-only hook-forwarder endpoint. Fail-open and silent by design: this
// script must never alter the foreign Claude session's hook decision, so it
// never writes to stdout and always exits 0, even if the bus is unreachable.
//
// Install (per foreign project) — see scripts/hooks/README.md.

const STDIN_TIMEOUT_MS = 1500;
const FETCH_TIMEOUT_MS = 1500;

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => settle(data), STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      settle(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      settle(data);
    });
  });
}

async function main() {
  const body = await readStdin();
  if (!body || !body.trim()) return;

  const port = process.env.DEVOS_PORT ?? 8787;
  const url = `http://127.0.0.1:${port}/hooks`;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

main()
  .catch(() => { /* fail-open: never surface errors to the foreign session */ })
  .finally(() => process.exit(0));
