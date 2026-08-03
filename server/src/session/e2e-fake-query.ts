// A deterministic, env-gated fake `query` — lets an e2e run drive a real
// `bridge-start` through `main()` without a live LLM. Mirrors `makeFakeSession`
// in `server/test/integration/bridge.test.ts`: yields a single `system/init`
// message (with a unique sdk id) then returns, a clean `ended`.
//
// Test-infrastructure by nature, but lives in `src/` because `main()` needs it
// at runtime, gated behind `DEVOS_E2E_FAKE_QUERY=1` (see index.ts).

import { randomUUID } from 'node:crypto';
import type { EngineMessage, EngineSession, QueryFn } from './session-engine.js';

function makeFakeSession(sdkId: string): EngineSession {
  async function* gen(): AsyncGenerator<EngineMessage> {
    yield { type: 'system', subtype: 'init', session_id: sdkId };
  }

  return Object.assign(gen(), {
    interrupt: async (): Promise<unknown> => undefined,
    send: async (): Promise<void> => {},
    onPermissionRequest: (): void => {},
    resolvePermission: (): void => {},
    onQuestionRequest: (): void => {},
    answerQuestion: (): void => {},
    end: (): void => {},
  });
}

/** Build a fake `QueryFn` that hands out a clean, single-`system/init` session
 * per call — driven by `DEVOS_E2E_FAKE_QUERY=1` in `main()`. */
export function createE2eFakeQuery(): QueryFn {
  return () => makeFakeSession(randomUUID());
}
