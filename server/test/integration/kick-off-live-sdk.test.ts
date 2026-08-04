// AC6 — LIVE Agent-SDK probe for the kick-off launcher (opt-in, human-accepted).
//
// This drives the REAL `@anthropic-ai/claude-agent-sdk` `query()` (via
// `defaultQuery`) against live Claude, using the exact spawn shape a kick-off
// launch uses: a fresh cwd, role 'builder', and the `/architect` slash-command
// prompt that starts the Decide-stage kickoff. It proves a slash-command
// kickoff prompt starts a real Claude Code session under the developer's
// Claude SUBSCRIPTION (OAuth keychain login) without crashing.
//
// It is RATE-LIMITED and non-deterministic, so it MUST NOT run in CI. It is
// SKIPPED unless `DEVOS_LIVE_SDK=1`. Run it once by hand, self-run only, on a
// machine with the Claude CLI logged in and `ANTHROPIC_API_KEY` empty:
//
//   DEVOS_LIVE_SDK=1 npx vitest run server/test/integration/kick-off-live-sdk.test.ts
//
// A human records the PASS in the story's decisions-log.md (AC6 sign-off).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultQuery } from '../../src/session/session-engine.js';

const LIVE = process.env.DEVOS_LIVE_SDK === '1';

// describe.skipIf keeps the suite compiled + typechecked, but only executes when
// the env flag is set — the default (CI) run reports it as skipped.
describe.skipIf(!LIVE)('live Agent-SDK kick-off (subscription auth)', () => {
  it('starts a real /architect session and receives a system/init with a session id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'devos-live-kickoff-'));
    try {
      const session = defaultQuery({
        cwd,
        role: 'builder',
        model: 'claude-opus-5[1m]',
        effort: 'medium',
        prompt: '/architect',
      });

      let sdkSessionId: string | null = null;
      // Safety net: cap how long we wait for the init message.
      const deadline = Date.now() + 60_000;
      for await (const message of session) {
        if (message.type === 'system' && message.subtype === 'init') {
          sdkSessionId = message.session_id ?? null;
          break;
        }
        if (Date.now() > deadline) break;
      }

      // Best-effort teardown: the single-message kickoff input closes immediately, so
      // the session may already have ended by now — interrupt() then throws
      // ("ProcessTransport is not ready"). That is harmless here (the manager's stopAll
      // guards interrupt the same way); the AC6 proof is the real system/init above.
      try {
        await session.interrupt();
      } catch {
        // session already ended — nothing to interrupt
      }

      expect(sdkSessionId).not.toBeNull();
      expect((sdkSessionId ?? '').length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});
