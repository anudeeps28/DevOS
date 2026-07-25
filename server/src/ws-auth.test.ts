// Unit tests for the WS connection-gate helpers (server/src/ws-auth.ts). Pure
// helpers — the only real resource is a loopback HTTP server bound on PORT=0 to
// prove buildAllowedOrigins reads the live bound port.

import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAllowedOrigins,
  extractSubprotocolToken,
  isLoopbackHost,
  isOriginAllowed,
  resolveAuthToken,
  tokensMatch,
} from './ws-auth.js';

describe('buildAllowedOrigins', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  async function listenOnEphemeralPort(): Promise<{ srv: Server; port: number }> {
    const srv = createServer();
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const address = srv.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected an AddressInfo from a listened server');
    }
    return { srv, port: address.port };
  }

  it('includes the live bound port own-origins and both dev origins when includeDevOrigins', async () => {
    const { srv, port } = await listenOnEphemeralPort();
    server = srv;

    const allowed = buildAllowedOrigins(srv, true);

    expect(allowed.has(`http://127.0.0.1:${port}`)).toBe(true);
    expect(allowed.has(`http://localhost:${port}`)).toBe(true);
    expect(allowed.has('http://127.0.0.1:5173')).toBe(true);
    expect(allowed.has('http://localhost:5173')).toBe(true);
  });

  it('omits the dev origins when includeDevOrigins is false (prod)', async () => {
    const { srv, port } = await listenOnEphemeralPort();
    server = srv;

    const allowed = buildAllowedOrigins(srv, false);

    // Own-origins for the bound port are still present…
    expect(allowed.has(`http://127.0.0.1:${port}`)).toBe(true);
    expect(allowed.has(`http://localhost:${port}`)).toBe(true);
    // …but the Vite 5173 dev origins are NOT merged in prod.
    expect(allowed.has('http://127.0.0.1:5173')).toBe(false);
    expect(allowed.has('http://localhost:5173')).toBe(false);
  });

  it('includes every extra origin passed in', async () => {
    const { srv } = await listenOnEphemeralPort();
    server = srv;

    const allowed = buildAllowedOrigins(srv, true, ['http://extra.test:9000']);

    expect(allowed.has('http://extra.test:9000')).toBe(true);
  });

  it('omits port own-origins when the server is not yet listening', () => {
    const srv = createServer();
    // Not calling srv.close in afterEach because it was never listened.
    const allowed = buildAllowedOrigins(srv, true);

    // Still carries the dev origins even without a bound port.
    expect(allowed.has('http://127.0.0.1:5173')).toBe(true);
    expect([...allowed].some((o) => /:\d+$/.test(o) && !o.endsWith(':5173'))).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback IPv4 with and without a port', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:8787')).toBe(true);
  });

  it('accepts localhost (case-insensitive) with and without a port', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('localhost:5173')).toBe(true);
    expect(isLoopbackHost('LocalHost:8787')).toBe(true);
  });

  it('accepts the IPv6 loopback in bracketed and bare forms', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('[::1]:8787')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('rejects a missing or empty Host header (fail closed)', () => {
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost('   ')).toBe(false);
  });

  it('rejects foreign / rebinding hosts', () => {
    expect(isLoopbackHost('evil.example')).toBe(false);
    expect(isLoopbackHost('evil.example:8787')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.10:8787')).toBe(false);
    expect(isLoopbackHost('[::2]:8787')).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  const allowed = new Set(['http://127.0.0.1:8787', 'http://localhost:8787']);

  it('rejects a present foreign origin in dev (requireToken=false)', () => {
    expect(isOriginAllowed('http://evil.example', allowed, false)).toBe(false);
  });

  it('rejects a present foreign origin in prod (requireToken=true)', () => {
    expect(isOriginAllowed('http://evil.example', allowed, true)).toBe(false);
  });

  it('accepts a present allowlisted origin', () => {
    expect(isOriginAllowed('http://127.0.0.1:8787', allowed, false)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:8787', allowed, true)).toBe(true);
  });

  it('allows an absent origin when a token is not required', () => {
    expect(isOriginAllowed(undefined, allowed, false)).toBe(true);
  });

  it('rejects an absent origin when a token is required (prod)', () => {
    expect(isOriginAllowed(undefined, allowed, true)).toBe(false);
  });
});

describe('extractSubprotocolToken', () => {
  it('parses the token entry from a comma-separated string header', () => {
    expect(extractSubprotocolToken('devos, token.abc')).toBe('abc');
  });

  it('parses a header delivered as string[]', () => {
    expect(extractSubprotocolToken(['devos', 'token.xyz'])).toBe('xyz');
  });

  it('returns null when no token entry is present', () => {
    expect(extractSubprotocolToken('devos')).toBeNull();
  });

  it('returns null for an undefined header', () => {
    expect(extractSubprotocolToken(undefined)).toBeNull();
  });
});

describe('tokensMatch', () => {
  it('is true for equal tokens', () => {
    expect(tokensMatch('secret-token', 'secret-token')).toBe(true);
  });

  it('is false for unequal same-length tokens', () => {
    expect(tokensMatch('secret-tokeX', 'secret-token')).toBe(false);
  });

  it('is false for a null provided token', () => {
    expect(tokensMatch(null, 'secret-token')).toBe(false);
  });

  it('is false for different-length tokens', () => {
    expect(tokensMatch('short', 'secret-token')).toBe(false);
  });
});

describe('resolveAuthToken', () => {
  const original = process.env.DEVOS_WS_TOKEN;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.DEVOS_WS_TOKEN;
    } else {
      process.env.DEVOS_WS_TOKEN = original;
    }
  });

  it('honors an explicit non-empty hex value over env', () => {
    process.env.DEVOS_WS_TOKEN = 'cafef00d';
    expect(resolveAuthToken('a1b2c3d4')).toBe('a1b2c3d4');
  });

  it('falls back to a hex DEVOS_WS_TOKEN when explicit is absent/empty', () => {
    process.env.DEVOS_WS_TOKEN = 'cafef00d';
    expect(resolveAuthToken()).toBe('cafef00d');
    expect(resolveAuthToken('')).toBe('cafef00d');
  });

  it('mints a 64-char hex token when neither explicit nor env is set', () => {
    delete process.env.DEVOS_WS_TOKEN;
    const token = resolveAuthToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on a non-hex explicit token (fail fast — misconfiguration)', () => {
    delete process.env.DEVOS_WS_TOKEN;
    expect(() => resolveAuthToken('not-hex!')).toThrow(/hex/i);
    expect(() => resolveAuthToken('DEADBEEF')).toThrow(/hex/i); // uppercase is not lowercase-hex
  });

  it('throws on a non-hex DEVOS_WS_TOKEN env value', () => {
    process.env.DEVOS_WS_TOKEN = 'not-hex-token';
    expect(() => resolveAuthToken()).toThrow(/hex/i);
  });
});
