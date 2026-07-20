// Integration test — live WS heartbeat stream (Acceptance criterion 1, server side).
//
// Boots the REAL server in-process on a free port (PORT=0), opens a real `ws`
// client to ws://127.0.0.1:<port>/ws, and proves the server pushes ≥2
// correctly-shaped, strictly-increasing heartbeat frames over the wire —
// independent of the browser UI.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type DevOsServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';

interface HeartbeatFrame {
  readonly type: 'heartbeat';
  readonly seq: number;
  readonly ts: number;
}

function isHeartbeatFrame(value: unknown): value is HeartbeatFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'heartbeat' &&
    typeof frame.seq === 'number' &&
    typeof frame.ts === 'number'
  );
}

// Open a client and collect exactly `count` heartbeat frames, or reject if they
// don't arrive in time. Awaits real 'open'/'message' events — the timeout is
// only a safety net against a hung stream.
function collectHeartbeats(url: string, count: number, timeoutMs: number): Promise<HeartbeatFrame[]> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    const frames: HeartbeatFrame[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      finish(
        new Error(
          `Timed out after ${timeoutMs}ms with ${frames.length}/${count} heartbeat frames`,
        ),
      );
    }, timeoutMs);

    function finish(err: Error | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeAllListeners();
      client.close();
      if (err !== null) reject(err);
      else resolve(frames);
    }

    client.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));

    client.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch (err) {
        finish(new Error(`Received a non-JSON frame: ${String(err)}`));
        return;
      }
      if (!isHeartbeatFrame(parsed)) {
        // Other frame types (e.g. the registry snapshot the gateway pushes on
        // connect) legitimately coexist with heartbeats on the same socket —
        // skip them rather than treating them as malformed.
        return;
      }
      // Immutable accumulate — snapshot then decide.
      frames.push(parsed);
      if (frames.length >= count) finish(null);
    });
  });
}

describe('WS client ↔ server heartbeat stream', () => {
  let instance: DevOsServer;
  let address: AddressInfo;

  beforeAll(async () => {
    // Given: the real server booted on a free port with the WS gateway attached.
    instance = createServer({ port: 0 });
    address = await instance.start();
  });

  afterAll(async () => {
    await instance.stop();
  });

  it(
    'delivers ≥2 correctly-shaped, strictly-increasing heartbeat frames',
    async () => {
      // When: a real ws client connects and collects the first two frames.
      const url = `ws://127.0.0.1:${address.port}${WS_PATH}`;
      const frames = await collectHeartbeats(url, 2, 3000);

      // Then: at least two frames arrived, each matching the pinned contract.
      expect(frames.length).toBeGreaterThanOrEqual(2);
      for (const frame of frames) {
        expect(frame.type).toBe('heartbeat');
        expect(typeof frame.seq).toBe('number');
        expect(typeof frame.ts).toBe('number');
        expect(Number.isFinite(frame.ts)).toBe(true);
      }

      // And: seq strictly increases between consecutive frames.
      const first = frames[0]!;
      const second = frames[1]!;
      expect(second.seq).toBeGreaterThan(first.seq);
    },
    10000,
  );
});
