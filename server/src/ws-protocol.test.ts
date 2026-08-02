import { describe, expect, it } from 'vitest';

import {
  parseInboundMessage,
  MAX_STEER_TEXT_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  type BridgeInterruptMessage,
  type BridgeStartMessage,
  type DiscoverMessage,
  type GateApproveMessage,
  type GitStateMessage,
  type PermissionDecisionMessage,
  type PinMessage,
  type RosterTimelineRequestMessage,
  type SessionInputMessage,
  type SessionInterruptMessage,
  type SessionPersonasMessage,
  type SessionTranscriptRequestMessage,
  type SkillsMessage,
  type TranscriptEventBody,
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

    it('returns null for a skills frame with a relative, empty, or missing path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'skills', path: 'relative/dir' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'skills', path: '' })),
      ).toBeNull();
      expect(parseInboundMessage(JSON.stringify({ type: 'skills' }))).toBeNull();
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

  describe('skills frames', () => {
    it('parses a skills message with an absolute path', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'skills', path: '/abs/path' }),
      );

      expect(result).toEqual<SkillsMessage>({ type: 'skills', path: '/abs/path' });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('returns null for a skills frame with an empty path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'skills', path: '' })),
      ).toBeNull();
    });

    it('returns null for a skills frame with a relative path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'skills', path: 'relative/dir' })),
      ).toBeNull();
    });

    it('returns null for a skills frame with an over-long path', () => {
      const path = '/' + 'a'.repeat(5000); // exceeds MAX_PATH_LENGTH (4096)
      expect(parseInboundMessage(JSON.stringify({ type: 'skills', path }))).toBeNull();
    });

    it('does not affect parsing of a non-skills type', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'git-state', path: '/abs/path' }),
      );
      expect(result).toEqual<GitStateMessage>({ type: 'git-state', path: '/abs/path' });
    });
  });

  describe('session-spawn frames', () => {
    it('accepts a spawn with an absolute path and a valid role', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'session-spawn', path: '/abs/project', role: 'builder' }),
      );
      expect(result).toEqual({ type: 'session-spawn', path: '/abs/project', role: 'builder' });
    });

    it('preserves workItemId when it is a string, omits it otherwise', () => {
      const withId = parseInboundMessage(
        JSON.stringify({ type: 'session-spawn', path: '/abs', role: 'builder', workItemId: 'WI-1' }),
      );
      expect(withId).toEqual({ type: 'session-spawn', path: '/abs', role: 'builder', workItemId: 'WI-1' });

      const noId = parseInboundMessage(
        JSON.stringify({ type: 'session-spawn', path: '/abs', role: 'builder', workItemId: 42 }),
      );
      expect(noId).toBeNull(); // non-string workItemId is rejected
    });

    it('rejects a spawn with an over-long workItemId', () => {
      const workItemId = 'x'.repeat(513); // exceeds MAX_WORK_ITEM_ID_LENGTH (512)
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'session-spawn', path: '/abs', role: 'builder', workItemId }),
        ),
      ).toBeNull();
    });

    it('rejects a spawn whose workItemId is a path-traversal payload', () => {
      for (const workItemId of ['../../../../etc', 'a/b', '..', '.hidden', 'WI 1', 'WI/../x']) {
        expect(
          parseInboundMessage(
            JSON.stringify({ type: 'session-spawn', path: '/abs', role: 'builder', workItemId }),
          ),
        ).toBeNull();
      }
    });

    it('rejects a spawn with an invalid or absent role', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-spawn', path: '/abs', role: 'captain' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-spawn', path: '/abs' })),
      ).toBeNull();
    });

    it('rejects a spawn with a relative or empty path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-spawn', path: 'rel/dir', role: 'reviewer' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-spawn', path: '', role: 'reviewer' })),
      ).toBeNull();
    });
  });

  describe('session-transcript-request frames', () => {
    it('accepts a request with a non-empty bounded sessionId, frozen', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'session-transcript-request', sessionId: 'sess-1' }),
      );

      expect(result).toEqual<SessionTranscriptRequestMessage>({
        type: 'session-transcript-request',
        sessionId: 'sess-1',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('strips extra junk keys from the request', () => {
      const result = parseInboundMessage(
        JSON.stringify({
          type: 'session-transcript-request',
          sessionId: 'sess-1',
          junk: 1,
          path: '/ignored',
        }),
      );

      expect(result).toEqual({ type: 'session-transcript-request', sessionId: 'sess-1' });
      expect(result as unknown as Record<string, unknown>).not.toHaveProperty('junk');
      expect(result as unknown as Record<string, unknown>).not.toHaveProperty('path');
    });

    it('accepts a sessionId exactly at the length limit', () => {
      const sessionId = 's'.repeat(128); // exactly MAX_SESSION_ID_LENGTH
      const result = parseInboundMessage(
        JSON.stringify({ type: 'session-transcript-request', sessionId }),
      );
      expect(result).not.toBeNull();
    });

    it('rejects an empty sessionId', () => {
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'session-transcript-request', sessionId: '' }),
        ),
      ).toBeNull();
    });

    it('rejects an over-long sessionId', () => {
      const sessionId = 's'.repeat(129); // exceeds MAX_SESSION_ID_LENGTH (128)
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-transcript-request', sessionId })),
      ).toBeNull();
    });

    it('rejects a wrong-type or missing sessionId', () => {
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'session-transcript-request', sessionId: 42 }),
        ),
      ).toBeNull();
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'session-transcript-request', sessionId: null }),
        ),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-transcript-request' })),
      ).toBeNull();
    });
  });

  describe('session-input frames', () => {
    it('accepts a session-input with a non-empty sessionId and text, frozen', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'session-input', sessionId: 'sess-1', text: 'hello' }),
      );

      expect(result).toEqual<SessionInputMessage>({
        type: 'session-input',
        sessionId: 'sess-1',
        text: 'hello',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('accepts an empty text string', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'session-input', sessionId: 'sess-1', text: '' }),
      );
      expect(result).toEqual<SessionInputMessage>({
        type: 'session-input',
        sessionId: 'sess-1',
        text: '',
      });
    });

    it('accepts text exactly at MAX_STEER_TEXT_LENGTH', () => {
      const text = 'x'.repeat(MAX_STEER_TEXT_LENGTH);
      const result = parseInboundMessage(
        JSON.stringify({ type: 'session-input', sessionId: 'sess-1', text }),
      );
      expect(result).not.toBeNull();
    });

    it('rejects text over MAX_STEER_TEXT_LENGTH', () => {
      const text = 'x'.repeat(MAX_STEER_TEXT_LENGTH + 1);
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'session-input', sessionId: 'sess-1', text }),
        ),
      ).toBeNull();
    });

    it('rejects a missing, empty, or wrong-type sessionId', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-input', text: 'hello' })),
      ).toBeNull();
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'session-input', sessionId: '', text: 'hello' }),
        ),
      ).toBeNull();
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'session-input', sessionId: 42, text: 'hello' }),
        ),
      ).toBeNull();
    });

    it('rejects a missing or non-string text', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-input', sessionId: 'sess-1' })),
      ).toBeNull();
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'session-input', sessionId: 'sess-1', text: 42 }),
        ),
      ).toBeNull();
    });
  });

  describe('session-interrupt frames', () => {
    it('accepts a session-interrupt with a non-empty bounded sessionId, frozen', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'session-interrupt', sessionId: 'sess-1' }),
      );

      expect(result).toEqual<SessionInterruptMessage>({
        type: 'session-interrupt',
        sessionId: 'sess-1',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('rejects a missing, empty, or wrong-type sessionId', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-interrupt' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-interrupt', sessionId: '' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-interrupt', sessionId: 42 })),
      ).toBeNull();
    });

    it('rejects an over-long sessionId', () => {
      const sessionId = 's'.repeat(129); // exceeds MAX_SESSION_ID_LENGTH (128)
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-interrupt', sessionId })),
      ).toBeNull();
    });
  });

  describe('bridge-start frames', () => {
    it('accepts a bridge-start with an absolute path and no workItemId', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'bridge-start', path: '/abs/project' }),
      );
      expect(result).toEqual<BridgeStartMessage>({ type: 'bridge-start', path: '/abs/project' });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('accepts a bridge-start with an absolute path and a workItemId', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'bridge-start', path: '/abs/project', workItemId: 'WI-1' }),
      );
      expect(result).toEqual<BridgeStartMessage>({
        type: 'bridge-start',
        path: '/abs/project',
        workItemId: 'WI-1',
      });
    });

    it('rejects a bridge-start with a missing or relative path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'bridge-start' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'bridge-start', path: 'rel/dir' })),
      ).toBeNull();
    });

    it('rejects a bridge-start with an over-long workItemId', () => {
      const workItemId = 'x'.repeat(513); // exceeds MAX_WORK_ITEM_ID_LENGTH (512)
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'bridge-start', path: '/abs', workItemId }),
        ),
      ).toBeNull();
    });

    it('rejects a bridge-start whose workItemId is a path-traversal payload', () => {
      for (const workItemId of ['../../etc', 'a/b', '..', '.hidden']) {
        expect(
          parseInboundMessage(JSON.stringify({ type: 'bridge-start', path: '/abs', workItemId })),
        ).toBeNull();
      }
    });
  });

  describe('gate-approve frames', () => {
    it('accepts a gate-approve with an absolute path', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'gate-approve', path: '/abs/project' }),
      );
      expect(result).toEqual<GateApproveMessage>({
        type: 'gate-approve',
        path: '/abs/project',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('rejects a gate-approve with a missing or relative path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'gate-approve' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'gate-approve', path: 'rel/dir' })),
      ).toBeNull();
    });
  });

  describe('permission-decision frames', () => {
    it('accepts a well-formed permission-decision with decision "allow", frozen', () => {
      const result = parseInboundMessage(
        JSON.stringify({
          type: 'permission-decision',
          sessionId: 'sess-1',
          requestId: 'req-1',
          decision: 'allow',
        }),
      );

      expect(result).toEqual<PermissionDecisionMessage>({
        type: 'permission-decision',
        sessionId: 'sess-1',
        requestId: 'req-1',
        decision: 'allow',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('accepts a well-formed permission-decision with decision "deny", frozen', () => {
      const result = parseInboundMessage(
        JSON.stringify({
          type: 'permission-decision',
          sessionId: 'sess-1',
          requestId: 'req-1',
          decision: 'deny',
        }),
      );

      expect(result).toEqual<PermissionDecisionMessage>({
        type: 'permission-decision',
        sessionId: 'sess-1',
        requestId: 'req-1',
        decision: 'deny',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('rejects a bad decision enum value', () => {
      expect(
        parseInboundMessage(
          JSON.stringify({
            type: 'permission-decision',
            sessionId: 'sess-1',
            requestId: 'req-1',
            decision: 'maybe',
          }),
        ),
      ).toBeNull();
    });

    it('rejects a missing or empty requestId', () => {
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'permission-decision', sessionId: 'sess-1', decision: 'allow' }),
        ),
      ).toBeNull();
      expect(
        parseInboundMessage(
          JSON.stringify({
            type: 'permission-decision',
            sessionId: 'sess-1',
            requestId: '',
            decision: 'allow',
          }),
        ),
      ).toBeNull();
    });

    it('rejects an oversized sessionId (> 128 chars)', () => {
      const sessionId = 's'.repeat(129); // exceeds MAX_SESSION_ID_LENGTH (128)
      expect(
        parseInboundMessage(
          JSON.stringify({
            type: 'permission-decision',
            sessionId,
            requestId: 'req-1',
            decision: 'allow',
          }),
        ),
      ).toBeNull();
    });

    it('rejects an oversized requestId (> MAX_REQUEST_ID_LENGTH)', () => {
      const requestId = 'r'.repeat(MAX_REQUEST_ID_LENGTH + 1);
      expect(
        parseInboundMessage(
          JSON.stringify({
            type: 'permission-decision',
            sessionId: 'sess-1',
            requestId,
            decision: 'allow',
          }),
        ),
      ).toBeNull();
    });

    it('accepts a well-formed permission-decision with decision "allow-always", frozen', () => {
      const result = parseInboundMessage(
        JSON.stringify({
          type: 'permission-decision',
          sessionId: 'sess-1',
          requestId: 'req-1',
          decision: 'allow-always',
        }),
      );

      expect(result).toEqual<PermissionDecisionMessage>({
        type: 'permission-decision',
        sessionId: 'sess-1',
        requestId: 'req-1',
        decision: 'allow-always',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('rejects decision "always" (not the actual allow-always literal)', () => {
      expect(
        parseInboundMessage(
          JSON.stringify({
            type: 'permission-decision',
            sessionId: 'sess-1',
            requestId: 'req-1',
            decision: 'always',
          }),
        ),
      ).toBeNull();
    });
  });

  describe('session-personas frames', () => {
    it('accepts a session-personas message with an absolute path, frozen', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'session-personas', path: '/abs/project' }),
      );
      expect(result).toEqual<SessionPersonasMessage>({
        type: 'session-personas',
        path: '/abs/project',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('rejects a session-personas message with a missing, empty, or relative path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-personas' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-personas', path: '' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'session-personas', path: 'rel/dir' })),
      ).toBeNull();
    });
  });

  describe('roster-timeline frames', () => {
    it('accepts a roster-timeline message with an absolute path, frozen', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'roster-timeline', path: '/abs/project' }),
      );
      expect(result).toEqual<RosterTimelineRequestMessage>({
        type: 'roster-timeline',
        path: '/abs/project',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('rejects a roster-timeline message with a missing, empty, or relative path', () => {
      expect(
        parseInboundMessage(JSON.stringify({ type: 'roster-timeline' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'roster-timeline', path: '' })),
      ).toBeNull();
      expect(
        parseInboundMessage(JSON.stringify({ type: 'roster-timeline', path: 'rel/dir' })),
      ).toBeNull();
    });
  });

  describe('bridge-interrupt frames', () => {
    it('accepts a bridge-interrupt with an absolute path and a reason', () => {
      const result = parseInboundMessage(
        JSON.stringify({ type: 'bridge-interrupt', path: '/abs/project', reason: 'stop now' }),
      );
      expect(result).toEqual<BridgeInterruptMessage>({
        type: 'bridge-interrupt',
        path: '/abs/project',
        reason: 'stop now',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('rejects a bridge-interrupt with a missing or relative path', () => {
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'bridge-interrupt', reason: 'stop now' }),
        ),
      ).toBeNull();
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'bridge-interrupt', path: 'rel/dir', reason: 'stop now' }),
        ),
      ).toBeNull();
    });

    it('rejects a bridge-interrupt with a non-string reason', () => {
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'bridge-interrupt', path: '/abs/project', reason: 42 }),
        ),
      ).toBeNull();
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'bridge-interrupt', path: '/abs/project' }),
        ),
      ).toBeNull();
    });

    it('rejects a bridge-interrupt with an over-long reason', () => {
      const reason = 'x'.repeat(4097); // exceeds MAX_REASON_LENGTH (4096)
      expect(
        parseInboundMessage(
          JSON.stringify({ type: 'bridge-interrupt', path: '/abs/project', reason }),
        ),
      ).toBeNull();
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

  describe('TranscriptEventBody', () => {
    it('accepts a user-text shape', () => {
      const body: TranscriptEventBody = { kind: 'user-text', text: 'steer this' };
      expect(body).toEqual({ kind: 'user-text', text: 'steer this' });
    });
  });
});
