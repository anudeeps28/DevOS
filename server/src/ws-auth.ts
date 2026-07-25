// WebSocket connection-gate helpers — pure, side-effect-free. NO ws import and
// NO server attachment here; this module only builds the origin allowlist and
// mints/extracts/compares the local token. It is unit-testable in isolation.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WS_DEV_ORIGINS } from './config.js';

/** The fixed subprotocol the browser handshake echoes. */
export const SUBPROTOCOL = 'devos';

/** Prefix marking the token-bearing entry in the subprotocol list. */
export const TOKEN_PROTO_PREFIX = 'token.';

/** Hostnames accepted by the HTTP Host-header loopback gate. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** A resolved local WS token must be a non-empty lowercase hex string. */
const HEX_TOKEN_RE = /^[0-9a-f]+$/;

/**
 * Whether a raw HTTP `Host` header names a loopback host. Parses the hostname out
 * of the header (stripping any `:port`, including the bracketed IPv6 `[::1]:port`
 * form) and checks it against the loopback allowlist (127.0.0.1 / localhost / ::1).
 * A missing, empty, or non-loopback Host yields false — this is the HTTP-side twin
 * of the WS Origin gate and MUST fail closed (DNS-rebinding defense).
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false;
  const trimmed = hostHeader.trim();
  if (trimmed.length === 0) return false;

  let hostname: string;
  if (trimmed.startsWith('[')) {
    // Bracketed IPv6 literal: `[::1]` or `[::1]:port`.
    const end = trimmed.indexOf(']');
    if (end === -1) return false;
    hostname = trimmed.slice(1, end);
  } else if ((trimmed.match(/:/g) ?? []).length > 1) {
    // Unbracketed IPv6 literal (multiple colons, no port) — take it whole.
    hostname = trimmed;
  } else {
    // IPv4 or hostname, optionally `:port`.
    const idx = trimmed.indexOf(':');
    hostname = idx === -1 ? trimmed : trimmed.slice(0, idx);
  }

  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Build the set of origins allowed to open a WS connection. Reads the server
 * address LIVE (so a PORT=0 test resolves the real bound port), adds both
 * loopback own-origins for that port, every WS_DEV_ORIGINS entry when
 * `includeDevOrigins` is set (dev only), and every `extra` entry.
 */
export function buildAllowedOrigins(
  server: import('node:http').Server,
  includeDevOrigins: boolean,
  extra?: readonly string[],
): Set<string> {
  const allowed = new Set<string>();

  const address = server.address();
  if (address !== null && typeof address === 'object') {
    const { port } = address;
    allowed.add(`http://127.0.0.1:${port}`);
    allowed.add(`http://localhost:${port}`);
  }

  // Vite dev-page origins (5173) belong ONLY in dev — never merge them in prod,
  // where the token is required and the app is served from the loopback port itself.
  if (includeDevOrigins) {
    for (const origin of WS_DEV_ORIGINS) {
      allowed.add(origin);
    }
  }

  if (extra !== undefined) {
    for (const origin of extra) {
      allowed.add(origin);
    }
  }

  return allowed;
}

/**
 * Decide whether an upgrade's Origin is allowed. A present origin must be in the
 * allowlist (a foreign browser origin is rejected in BOTH dev and prod). An
 * absent origin is allowed only when a token is not required (dev/test); in prod
 * (`requireToken`) an origin-absent handshake is rejected.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: Set<string>,
  requireToken: boolean,
): boolean {
  if (origin !== undefined) {
    return allowed.has(origin);
  }
  return !requireToken;
}

/**
 * Parse the comma-separated `sec-websocket-protocol` header and return the token
 * carried by the `token.<hex>` entry, or null when absent.
 */
export function extractSubprotocolToken(
  header: string | string[] | undefined,
): string | null {
  if (header === undefined) {
    return null;
  }
  const joined = Array.isArray(header) ? header.join(',') : header;
  const entries = joined.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    if (entry.startsWith(TOKEN_PROTO_PREFIX)) {
      return entry.slice(TOKEN_PROTO_PREFIX.length);
    }
  }
  return null;
}

/**
 * Constant-time compare of a provided token against the expected one. False when
 * provided is null or the lengths differ (timingSafeEqual requires equal length).
 */
export function tokensMatch(provided: string | null, expected: string): boolean {
  if (provided === null) {
    return false;
  }
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Resolve the local auth token: an explicit non-empty value wins, else a
 * non-empty `DEVOS_WS_TOKEN` env var, else a freshly minted 32-byte hex string.
 *
 * A supplied (explicit or env) token MUST be a lowercase hex string. A malformed
 * token is a misconfiguration, and since it is injected verbatim into the
 * index.html `<meta content="…">`, a non-hex value would be an attribute-breakout
 * XSS vector — so we fail fast at startup rather than mint/inject it silently. A
 * minted token is always hex, so it always passes.
 */
export function resolveAuthToken(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) {
    if (!HEX_TOKEN_RE.test(explicit)) {
      throw new Error(
        'Invalid WS auth token: the supplied token must be a non-empty lowercase hex string.',
      );
    }
    return explicit;
  }
  const fromEnv = process.env.DEVOS_WS_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!HEX_TOKEN_RE.test(fromEnv)) {
      throw new Error(
        'Invalid DEVOS_WS_TOKEN: the token must be a non-empty lowercase hex string.',
      );
    }
    return fromEnv;
  }
  return randomBytes(32).toString('hex');
}
