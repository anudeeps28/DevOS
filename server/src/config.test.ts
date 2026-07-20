// Negative-direction tests for the loopback-only security invariant
// (ARCHITECTURE §6). The positive path (server binds 127.0.0.1) is proven by the
// integration bind test; here we prove the guard REFUSES non-loopback hosts, at
// both boundaries: config resolution and the createServer() bind seam.

import { describe, expect, it } from 'vitest';
import { assertLoopbackHost } from './config.js';
import { createServer } from './index.js';

describe('assertLoopbackHost', () => {
  it('accepts and returns the loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(assertLoopbackHost(host)).toBe(host);
    }
  });

  it('throws for non-loopback hosts', () => {
    for (const host of ['0.0.0.0', '192.168.1.5', '10.0.0.1', 'example.com', '::']) {
      expect(() => assertLoopbackHost(host)).toThrow(/loopback/i);
    }
  });
});

describe('createServer host validation (defense-in-depth)', () => {
  it('refuses an explicit non-loopback host at the bind boundary', () => {
    expect(() => createServer({ host: '0.0.0.0' })).toThrow(/loopback/i);
    expect(() => createServer({ host: '192.168.1.5' })).toThrow(/loopback/i);
  });

  it('allows an explicit loopback host', () => {
    // Does not throw; we do not start() it, so no port is bound.
    expect(() => createServer({ host: '127.0.0.1', port: 0 })).not.toThrow();
  });
});
