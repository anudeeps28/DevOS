// Unit tests — `createInputStream` in isolation. NEVER imports the real
// `@anthropic-ai/claude-agent-sdk`; the queue logic is pure and structural.

import { describe, expect, it, vi } from 'vitest';
import { createInputStream, MAX_PENDING_INPUTS } from './session-engine.js';

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
