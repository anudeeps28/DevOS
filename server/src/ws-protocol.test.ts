import { describe, expect, it } from 'vitest';

import {
  parseInboundMessage,
  type DiscoverMessage,
  type GitStateMessage,
  type PinMessage,
  type UnpinMessage,
} from './ws-protocol.js';

describe('parseInboundMessage', () => {
  describe('valid frames', () => {
    it('parses a minimal pin message', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'pin', path: '/abs/path' }),
      );

      expect(result).toEqual<PinMessage>({ type: 'pin', path: '/abs/path' });
    });

    it('parses a pin message carrying displayName and uiPrefs', () => {
      const result = parseInboundMessage(
        JSON.stringify({
          type: 'pin',
          path: '/abs/path',
          displayName: 'My Proj',
          uiPrefs: { theme: 'dark' },
        }),
      );

      expect(result).toEqual<PinMessage>({
        type: 'pin',
        path: '/abs/path',
        displayName: 'My Proj',
        uiPrefs: { theme: 'dark' },
      });
    });

    it('parses an unpin message', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'unpin', path: '/abs/path' }),
      );

      expect(result).toEqual<UnpinMessage>({ type: 'unpin', path: '/abs/path' });
    });

    it('parses a git-state message with an absolute path', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'git-state', path: '/abs/path' }),
      );

      expect(result).toEqual<GitStateMessage>({ type: 'git-state', path: '/abs/path' });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('parses a discover message into a frozen { type: "discover" } with no path', () => {
      // Given: a bare discover frame (carries no payload)
      const result = parseInboundMessage(JSON.stringify({ type: 'discover' }));

      // Then: the exact discover message shape, frozen, with no path field
      expect(result).toEqual<DiscoverMessage>({ type: 'discover' });
      expect(result).not.toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
      expect(result as unknown as Record<string, unknown>).not.toHaveProperty('path');
    });

    it('parses a discover frame with extra junk keys, stripping them', () => {
      // Given: a discover frame polluted with unexpected keys
      const result = parseInboundMessage(
        JSON.stringify({ type: 'discover', path: '/ignored', junk: 1, nested: { a: 2 } }),
      );

      // Then: only { type: 'discover' } survives the boundary
      expect(result).toEqual<DiscoverMessage>({ type: 'discover' });
      expect(result as unknown as Record<string, unknown>).not.toHaveProperty('path');
      expect(result as unknown as Record<string, unknown>).not.toHaveProperty('junk');
    });
  });

  describe('malformed frames return null', () => {
    it('returns null for non-string input', () => {
      expect(parseInboundMessage(42)).toBeNull();
      expect(parseInboundMessage({ type: 'pin', path: '/abs/path' })).toBeNull();
      expect(parseInboundMessage(null)).toBeNull();
      expect(parseInboundMessage(undefined)).toBeNull();
    });

    it('returns null for a non-JSON string', () => {
      expect(parseInboundMessage('not json{')).toBeNull();
    });

    it('returns null for a JSON primitive that is not an object', () => {
      expect(parseInboundMessage(JSON.stringify(123))).toBeNull();
      expect(parseInboundMessage(JSON.stringify('a string'))).toBeNull();
      expect(parseInboundMessage(JSON.stringify(null))).toBeNull();
    });

    it('returns null when path is missing', () => {
      expect(parseInboundMessage(JSON.stringify({ type: 'pin' }))).toBeNull();
    });

    it('returns null when path is an empty string', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'pin', path: '' })),
      ).toBeNull();
    });

    it('returns null for a relative path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'pin', path: 'relative/dir' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'unpin', path: 'relative/dir' })),
      ).toBeNull();
    });

    it('returns null for a git-state frame with a relative, empty, or missing path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'git-state', path: 'relative/dir' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'git-state', path: '' })),
      ).toBeNull();
      expect(parseInboundMessage(JSON.stringify({ type: 'git-state' }))).toBeNull();
    });

    it('returns null for an unknown type', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'frobnicate', path: '/abs' })),
      ).toBeNull();
    });

    it('returns null for a heartbeat frame', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'heartbeat', seq: 1, ts: 1 })),
      ).toBeNull();
    });
  });

  describe('size limits (boundary hardening)', () => {
    it('rejects an over-long path', () => {
      const path = '/' + 'a'.repeat(5000); // exceeds MAX_PATH_LENGTH (4096)
      expect(parseInboundMessage(JSON.stringify({ type: 'pin', path }))).toBeNull();
    });

    it('rejects a pin with an over-long displayName', () => {
      const displayName = 'x'.repeat(600); // exceeds MAX_DISPLAY_NAME_LENGTH (512)
      expect(
        parseInboundMessage(JSON.stringify({ type: 'pin', path: '/abs/path', displayName })),
      ).toBeNull();
    });

    it('rejects an oversized raw frame before parsing', () => {
      const huge = JSON.stringify({ type: 'pin', path: '/abs/path', uiPrefs: 'z'.repeat(70000) });
      expect(parseInboundMessage(huge)).toBeNull();
    });

    it('accepts a path and displayName at the limit', () => {
      const path = '/' + 'a'.repeat(4095); // exactly MAX_PATH_LENGTH
      const displayName = 'x'.repeat(512); // exactly MAX_DISPLAY_NAME_LENGTH
      const result = parseInboundMessage(JSON.stringify({ type: 'pin', path, displayName }));
      expect(result).not.toBeNull();
    });
  });

  it('never throws on malformed input', () => {
    const inputs: unknown[] = [
      42,
      { type: 'pin', path: '/abs/path' },
      null,
      undefined,
      'not json{',
      JSON.stringify(123),
      JSON.stringify({ type: 'pin' }),
      JSON.stringify({ type: 'pin', path: '' }),
      JSON.stringify({ type: 'pin', path: 'relative/dir' }),
      JSON.stringify({ type: 'frobnicate', path: '/abs' }),
      JSON.stringify({ type: 'heartbeat', seq: 1, ts: 1 }),
    ];

    for (const input of inputs) {
      expect(() => parseInboundMessage(input)).not.toThrow();
    }
  });
});
