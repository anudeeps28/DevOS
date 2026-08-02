// Unit tests — `createInputStream` in isolation. NEVER imports the real
// `@anthropic-ai/claude-agent-sdk`; the queue logic is pure and structural.
// EXCEPTION: the AC5 live probe at the bottom of this file imports `defaultQuery`
// (the real-SDK adapter) but is skipped unless DEVOS_LIVE_SDK=1 — see live-sdk-smoke.test.ts
// for the established pattern this mirrors.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionOptions,
  createInputStream,
  createPermissionBroker,
  defaultQuery,
  MAX_PENDING_INPUTS,
  MAX_PENDING_PERMISSIONS,
} from './session-engine.js';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

describe('createInputStream', () => {
  it('yields the initial kickoff message first', async () => {
    const input = createInputStream('go');

    const { value, done } = await input.stream.next();

    expect(done).toBe(false);
    expect(value).toEqual({
      type: 'user',
      message: { role: 'user', content: 'go' },
      parent_tool_use_id: null,
    });
  });

  it('yields a pushed message after the kickoff', async () => {
    const input = createInputStream('go');
    await input.stream.next();

    input.push('hello');
    const { value, done } = await input.stream.next();

    expect(done).toBe(false);
    expect(value).toMatchObject({ message: { content: 'hello' } });
  });

  it('close() completes the generator, draining a queued push first', async () => {
    const input = createInputStream('go');
    await input.stream.next();

    input.push('queued');
    input.close();

    const drained = await input.stream.next();
    expect(drained.done).toBe(false);
    expect(drained.value).toMatchObject({ message: { content: 'queued' } });

    const finished = await input.stream.next();
    expect(finished.done).toBe(true);
  });

  it('push() after close() is a no-op', async () => {
    const input = createInputStream('go');
    await input.stream.next();

    input.close();
    input.push('too late');

    const finished = await input.stream.next();
    expect(finished.done).toBe(true);
  });

  it('drops pushes past MAX_PENDING_INPUTS (bounded backlog) without growing unbounded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = createInputStream('go');
    await input.stream.next(); // consume kickoff; the generator is now awaiting

    // Fill the backlog to the cap, then push one more — it must be dropped.
    for (let n = 0; n < MAX_PENDING_INPUTS; n += 1) input.push(`msg-${n}`);
    input.push('overflow');
    expect(warn).toHaveBeenCalledTimes(1);

    // Drain: exactly MAX_PENDING_INPUTS messages come out, in order, none is 'overflow'.
    const drained: string[] = [];
    for (let n = 0; n < MAX_PENDING_INPUTS; n += 1) {
      const { value } = await input.stream.next();
      drained.push((value as { message: { content: string } }).message.content);
    }
    expect(drained).toHaveLength(MAX_PENDING_INPUTS);
    expect(drained[0]).toBe('msg-0');
    expect(drained).not.toContain('overflow');

    input.close();
    warn.mockRestore();
  });
});

describe('createPermissionBroker', () => {
  it('canUseTool parks a Promise and fires onRequest with the request shape', async () => {
    const broker = createPermissionBroker();
    const requests: unknown[] = [];
    broker.onRequest((req) => requests.push(req));

    const controller = new AbortController();
    let settled = false;
    const promise = broker.canUseTool(
      'Bash',
      { command: 'ls' },
      { requestId: 'req-1', toolUseID: 'tu-1', signal: controller.signal } as never,
    );
    void promise.then(() => {
      settled = true;
    });

    // Give the microtask queue a tick — the promise must NOT resolve on its own.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(requests).toEqual([
      {
        requestId: 'req-1',
        toolUseId: 'tu-1',
        toolName: 'Bash',
        title: null,
        input: JSON.stringify({ command: 'ls' }),
      },
    ]);

    broker.resolve('req-1', 'allow');
    await promise;
  });

  it('resolve(requestId, "allow") resolves the parked Promise to { behavior: "allow" }', async () => {
    const broker = createPermissionBroker();
    const controller = new AbortController();
    const promise = broker.canUseTool(
      'Bash',
      {},
      { requestId: 'req-allow', signal: controller.signal } as never,
    );

    broker.resolve('req-allow', 'allow');
    const result = await promise;
    expect(result).toEqual<PermissionResult>({ behavior: 'allow' });
  });

  it('resolve(requestId, "deny") resolves to a deny with a message and no interrupt field', async () => {
    const broker = createPermissionBroker();
    const controller = new AbortController();
    const promise = broker.canUseTool(
      'Bash',
      {},
      { requestId: 'req-deny', signal: controller.signal } as never,
    );

    broker.resolve('req-deny', 'deny');
    const result = (await promise) as { behavior: string; message?: string; interrupt?: unknown };
    expect(result.behavior).toBe('deny');
    expect(typeof result.message).toBe('string');
    expect(result).not.toHaveProperty('interrupt');
  });

  it('denyAll() resolves every still-pending Promise to a deny', async () => {
    const broker = createPermissionBroker();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const a = broker.canUseTool('Bash', {}, { requestId: 'a', signal: controllerA.signal } as never);
    const b = broker.canUseTool('Bash', {}, { requestId: 'b', signal: controllerB.signal } as never);

    broker.denyAll();

    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA?.behavior).toBe('deny');
    expect(resultB?.behavior).toBe('deny');
  });

  it('aborting the AbortController signal resolves that pending Promise to a deny', async () => {
    const broker = createPermissionBroker();
    const controller = new AbortController();
    const promise = broker.canUseTool(
      'Bash',
      {},
      { requestId: 'req-abort', signal: controller.signal } as never,
    );

    controller.abort();
    const result = await promise;
    expect(result?.behavior).toBe('deny');
  });

  it('over-cap: the next canUseTool call resolves immediately to a deny (queue full)', async () => {
    const broker = createPermissionBroker();
    for (let n = 0; n < MAX_PENDING_PERMISSIONS; n += 1) {
      const controller = new AbortController();
      broker.canUseTool('Bash', {}, { requestId: `req-${n}`, signal: controller.signal } as never);
    }

    const controller = new AbortController();
    const overflow = await broker.canUseTool(
      'Bash',
      {},
      { requestId: 'overflow', signal: controller.signal } as never,
    );
    expect(overflow?.behavior).toBe('deny');
  });
});

describe('createPermissionBroker — allow-always (AC1/AC2/AC3)', () => {
  it('AC1: resolve(requestId, "allow-always") resolves to an allow carrying an addRules updatedPermissions for that tool, no ruleContent', async () => {
    const broker = createPermissionBroker();
    const controller = new AbortController();
    const promise = broker.canUseTool(
      'Bash',
      { command: 'ls' },
      { requestId: 'req-always', signal: controller.signal } as never,
    );

    broker.resolve('req-always', 'allow-always');
    const result = await promise;

    expect(result).toEqual<PermissionResult>({
      behavior: 'allow',
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      ],
    });
    const withRules = result as { updatedPermissions: Array<{ rules: Array<Record<string, unknown>> }> };
    expect(withRules.updatedPermissions[0]?.rules[0]).not.toHaveProperty('ruleContent');
    expect(result).not.toHaveProperty('permissionMode');
  });

  it('AC2 (regression): resolve(requestId, "allow") still resolves to {behavior:"allow"} with no updatedPermissions', async () => {
    const broker = createPermissionBroker();
    const controller = new AbortController();
    const promise = broker.canUseTool(
      'Bash',
      {},
      { requestId: 'req-allow-regress', signal: controller.signal } as never,
    );

    broker.resolve('req-allow-regress', 'allow');
    const result = await promise;

    expect(result).toEqual<PermissionResult>({ behavior: 'allow' });
    expect(result).not.toHaveProperty('updatedPermissions');
  });

  it('AC2 (regression): resolve(requestId, "deny") still resolves to {behavior:"deny", message:"Denied by operator"}', async () => {
    const broker = createPermissionBroker();
    const controller = new AbortController();
    const promise = broker.canUseTool(
      'Bash',
      {},
      { requestId: 'req-deny-regress', signal: controller.signal } as never,
    );

    broker.resolve('req-deny-regress', 'deny');
    const result = await promise;

    expect(result).toEqual<PermissionResult>({ behavior: 'deny', message: 'Denied by operator' });
  });

  it('AC3: the always-allow resolve result carries no permissionMode key', async () => {
    const broker = createPermissionBroker();
    const controller = new AbortController();
    const promise = broker.canUseTool(
      'Bash',
      {},
      { requestId: 'req-no-mode', signal: controller.signal } as never,
    );

    broker.resolve('req-no-mode', 'allow-always');
    const result = await promise;

    expect('permissionMode' in (result ?? {})).toBe(false);
  });

  it('prune/cap: a second resolve() for an already-resolved (pruned) requestId is a no-op', async () => {
    const broker = createPermissionBroker();
    const controller = new AbortController();
    const promise = broker.canUseTool(
      'Bash',
      {},
      { requestId: 'req-prune', signal: controller.signal } as never,
    );

    broker.resolve('req-prune', 'allow-always');
    const result = await promise;
    expect(result?.behavior).toBe('allow');

    // The requestId was pruned on first resolve — a repeat call (e.g. a second tab's
    // click) must not throw and must not settle anything new.
    expect(() => broker.resolve('req-prune', 'deny')).not.toThrow();
    expect(() => broker.denyAll()).not.toThrow();
  });
});

describe('buildSessionOptions — AC3 no-bypass regression', () => {
  it('returns Options with a canUseTool function and NO bypass permissionMode', () => {
    const broker = createPermissionBroker();
    const options = buildSessionOptions(
      { cwd: '/tmp/proj', role: 'builder', model: 'claude-opus-5[1m]', effort: 'medium' },
      broker,
    );

    expect(typeof options.canUseTool).toBe('function');
    expect(options.permissionMode).toBeUndefined();
  });
});

describe('buildSessionOptions — AC2a model/effort pass-through', () => {
  it('carries the roster-declared model and effort onto Options, alongside cwd/env/systemPrompt/canUseTool', () => {
    const broker = createPermissionBroker();
    const options = buildSessionOptions(
      { cwd: '/tmp/proj', role: 'builder', model: 'claude-opus-5[1m]', effort: 'medium' },
      broker,
    );

    expect(options.model).toBe('claude-opus-5[1m]');
    expect(options.effort).toBe('medium');
    expect(options.cwd).toBe('/tmp/proj');
    expect(options.env).toBeDefined();
    expect(options.systemPrompt).toBeDefined();
    expect(typeof options.canUseTool).toBe('function');
  });
});

// AC5 — LIVE Agent-SDK probe for allow-always (opt-in, human-accepted). Mirrors
// server/test/integration/live-sdk-smoke.test.ts: skipped unless DEVOS_LIVE_SDK=1, so
// it NEVER runs in CI and never calls the live SDK by default. Run it once by hand:
//
//   DEVOS_LIVE_SDK=1 npx vitest run server/src/session/session-engine.test.ts
const LIVE = process.env.DEVOS_LIVE_SDK === '1';

describe.skipIf(!LIVE)('live Agent-SDK "allow-always" (AC5)', () => {
  it('answering the first permission request with "allow-always" auto-approves a repeated same-tool call without a second prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'devos-live-allow-always-'));
    try {
      const session = defaultQuery({
        cwd,
        role: 'builder',
        model: 'claude-opus-5[1m]',
        effort: 'medium',
        prompt: 'Run the shell command `echo hello` twice in a row using the Bash tool, then stop.',
      });

      const permissionRequestIds: string[] = [];
      session.onPermissionRequest((req) => {
        permissionRequestIds.push(req.requestId);
        const decision = permissionRequestIds.length === 1 ? 'allow-always' : 'allow';
        session.resolvePermission(req.requestId, decision);
      });

      const deadline = Date.now() + 90_000;
      for await (const message of session) {
        if (message.type === 'result') break;
        if (Date.now() > deadline) break;
      }

      try {
        await session.interrupt();
      } catch {
        // session already ended — nothing to interrupt
      }

      expect(permissionRequestIds).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
