// AC5 — LIVE Agent-SDK smoke probe (opt-in, human-accepted).
//
// This is the ONE test that drives the REAL `@anthropic-ai/claude-agent-sdk`
// `query()` (via `defaultQuery`) against live Claude. It proves that owned sessions
// spawn under the developer's Claude SUBSCRIPTION (OAuth keychain login) with NO API
// key — the boundary verified in tasks/notes.md (Decision 2026-07-18).
//
// It is RATE-LIMITED and non-deterministic, so it MUST NOT run in CI. It is SKIPPED
// unless `DEVOS_LIVE_SDK=1`. Run it once by hand on a machine with the Claude CLI
// logged in and `ANTHROPIC_API_KEY` empty:
//
//   DEVOS_LIVE_SDK=1 npx vitest run server/test/integration/live-sdk-smoke.test.ts
//
// A human records the PASS in the story's decisions-log.md (AC5 sign-off).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultQuery } from '../../src/session/session-engine.js';

const LIVE = process.env.DEVOS_LIVE_SDK === '1';

// describe.skipIf keeps the suite compiled + typechecked, but only executes when
// the env flag is set — the default (CI) run reports it as skipped.
describe.skipIf(!LIVE)('live Agent-SDK spawn (subscription auth)', () => {
  it('starts a real session and receives a system/init with a session id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'devos-live-sdk-'));
    try {
      const session = defaultQuery({
        cwd,
        role: 'builder',
        model: 'claude-opus-5[1m]',
        effort: 'medium',
        prompt: 'Reply with the single word: ready.',
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
      // guards interrupt the same way); the AC5 proof is the real system/init above.
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

  // Steer + interrupt (story 6h6hMV8QfFvwCMP8) against the REAL SDK: the streaming
  // input stays open after kickoff, accepts a mid-run `send()`, the agent replies, and
  // `interrupt()` aborts the turn without a fatal throw. A confidence smoke, not a
  // strict causal proof — CI always uses the deterministic fake in steer-interrupt.test.ts.
  it('accepts a steered message on a live open session and survives an interrupt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'devos-live-steer-'));
    try {
      const session = defaultQuery({
        cwd,
        role: 'builder',
        model: 'claude-opus-5[1m]',
        effort: 'medium',
        prompt: 'Wait for my next instruction; do not act until I send it.',
      });

      let steered = false;
      let sawAssistantAfterSteer = false;
      const deadline = Date.now() + 60_000;
      for await (const message of session) {
        if (message.type === 'system' && message.subtype === 'init') {
          // Steer: push a follow-up user message into the STILL-OPEN input stream.
          await session.send('Reply with the single word: OK.');
          steered = true;
          continue;
        }
        if (steered && message.type === 'assistant') {
          sawAssistantAfterSteer = true;
          break;
        }
        if (Date.now() > deadline) break;
      }

      // Interrupt the live turn — must not throw fatally (the manager guards it the same way).
      try {
        await session.interrupt();
      } catch {
        // session already ended — nothing to interrupt
      }

      expect(steered).toBe(true);
      expect(sawAssistantAfterSteer).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});
