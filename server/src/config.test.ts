// Negative-direction tests for the loopback-only security invariant
// (ARCHITECTURE §6). The positive path (server binds 127.0.0.1) is proven by the
// integration bind test; here we prove the guard REFUSES non-loopback hosts, at
// both boundaries: config resolution and the createServer() bind seam.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { assertLoopbackHost, resolveProjectRoots } from './config.js';
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

describe('resolveProjectRoots', () => {
  // The function reads process.env.DEVOS_PROJECT_ROOTS at call time; save and
  // restore it around each case so tests don't leak into one another.
  const savedRoots = process.env.DEVOS_PROJECT_ROOTS;

  afterEach(() => {
    if (savedRoots === undefined) {
      delete process.env.DEVOS_PROJECT_ROOTS;
    } else {
      process.env.DEVOS_PROJECT_ROOTS = savedRoots;
    }
  });

  it('splits a colon-delimited value into ordered segments', () => {
    // Given: two roots separated by a colon
    process.env.DEVOS_PROJECT_ROOTS = '/a:/b';

    // When/Then: they are returned in order
    expect(resolveProjectRoots()).toEqual(['/a', '/b']);
  });

  it('drops blank/whitespace-only segments', () => {
    // Given: a value with empty and whitespace-only segments interleaved
    process.env.DEVOS_PROJECT_ROOTS = '/a::  :/b';

    // When/Then: only the non-blank segments survive
    expect(resolveProjectRoots()).toEqual(['/a', '/b']);
  });

  it('falls back to ~/Programming when the env var is unset', () => {
    // Given: no configured roots
    delete process.env.DEVOS_PROJECT_ROOTS;

    // When/Then: the single default root is used
    expect(resolveProjectRoots()).toEqual([join(homedir(), 'Programming')]);
  });

  it('falls back to ~/Programming when the env var is empty or all-blank', () => {
    // Given: an empty value
    process.env.DEVOS_PROJECT_ROOTS = '';
    expect(resolveProjectRoots()).toEqual([join(homedir(), 'Programming')]);

    // And: a value whose every segment is blank
    process.env.DEVOS_PROJECT_ROOTS = ' : : ';
    expect(resolveProjectRoots()).toEqual([join(homedir(), 'Programming')]);
  });

  it('returns a frozen array', () => {
    process.env.DEVOS_PROJECT_ROOTS = '/a:/b';
    expect(Object.isFrozen(resolveProjectRoots())).toBe(true);
  });
});
