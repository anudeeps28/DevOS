// A deterministic, env-gated fake `query` — lets an e2e run drive a real
// `bridge-start` (or a `kick-off-next-stage` launch) through `main()` without a
// live LLM. Mirrors the self-driving `makeFakeSession` in the integration suites
// (`server/test/integration/bridge.test.ts`, `kick-off-next-stage.test.ts`):
// yields a single `system/init` message (with a unique sdk id), then STAYS OPEN
// (long-lived, `status: running`) until `interrupt()`/`end()` closes it — so a
// launched session actually renders as a live session in the UI, and the server's
// `stopAll` on teardown resolves the wait cleanly. (Previously it returned after
// the first yield, which React batched `running`+`ended` into a single render, so
// the session never reached the DOM.)
//
// Test-infrastructure by nature, but lives in `src/` because `main()` needs it
// at runtime, gated behind `DEVOS_E2E_FAKE_QUERY=1` (see index.ts).

import { randomUUID } from 'node:crypto';
import type { EngineMessage, EngineSession, QueryFn } from './session-engine.js';

function makeFakeSession(sdkId: string): EngineSession {
  let resolveOpen: (() => void) | null = null;
  const openWait = new Promise<void>((r) => {
    resolveOpen = r;
  });

  async function* gen(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
    await openWait; // stay open (long-lived) until interrupt()/end() closes it
  }

  return Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => {
      resolveOpen?.();
      return undefined;
    },
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    onQuestionRequest: (): void => {},
    answerQuestion: (): void => {},
    end: (): void => {
      resolveOpen?.();
    },
  });
}

/** Build a fake `QueryFn` that hands out a clean, single-`system/init` session
 * per call — driven by `DEVOS_E2E_FAKE_QUERY=1` in `main()`. */
export function createE2eFakeQuery(): QueryFn {
  return () => makeFakeSession(randomUUID());
}
