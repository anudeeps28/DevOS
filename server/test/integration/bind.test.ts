// Integration test — loopback-only bind probe (Acceptance criterion 2).
//
// Boots the REAL server in-process on a free port (PORT=0) and proves:
//   1. It binds 127.0.0.1 (IPv4) — not 0.0.0.0, not the LAN IP.
//   2. A connect attempt to the machine's non-loopback LAN IPv4 is refused or
//      times out (i.e. the server is not reachable off-loopback).
// If the host has no non-loopback IPv4, sub-assertion (2) is skipped with a note.

import net from 'node:net';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type DevOsServer } from '../../src/index.js';

// Outcome of a TCP connect probe against a host:port.
type ProbeResult = 'connected' | 'refused' | 'timeout' | 'unreachable';

// Attempt a bare TCP connect. Resolves with how the attempt ended — never
// rejects, so the caller asserts on the classification.
function probeTcpConnect(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('connected'));
    socket.once('timeout', () => finish('timeout'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED = actively refused; EHOSTUNREACH/ENETUNREACH = no route.
      // Both prove the server is not serving on that interface.
      finish(err.code === 'ECONNREFUSED' ? 'refused' : 'unreachable');
    });

    socket.connect(port, host);
  });
}

// First non-internal IPv4 address across all interfaces, or null if none exist.
function firstNonLoopbackIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}

describe('Server boot → loopback-only bind', () => {
  let instance: DevOsServer;
  let address: AddressInfo;

  beforeAll(async () => {
    // Given: the real server booted on a free port, loopback host (default).
    instance = createServer({ port: 0 });
    address = await instance.start();
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('binds 127.0.0.1 on an IPv4 family', () => {
    // When/Then: the bound address is loopback IPv4 — never 0.0.0.0 or a LAN IP.
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
    expect(address.port).toBeGreaterThan(0);
  });

  it('is not reachable on the machine non-loopback LAN IPv4', async () => {
    // Given: the machine's LAN IPv4 (if it has one).
    const lanIp = firstNonLoopbackIpv4();

    if (lanIp === null) {
      // No non-loopback IPv4 on this host — skip the off-loopback probe, but the
      // loopback bind is still asserted by the test above.
      console.log(
        '[bind.test] no non-loopback IPv4 interface found — skipping LAN-refusal sub-assertion',
      );
      return;
    }

    // When: connecting to the LAN IP on the server's port with a short timeout.
    const result = await probeTcpConnect(lanIp, address.port, 1500);

    // Then: the attempt must NOT succeed — refused, timed out, or unreachable.
    console.log(`[bind.test] LAN probe ${lanIp}:${address.port} → ${result}`);
    expect(result).not.toBe('connected');
    expect(['refused', 'timeout', 'unreachable']).toContain(result);
  });
});
