// Unit tests — the pure transcript normalizer. Every kind, block order,
// truncation, numeric coercion, and the never-throws guarantee (AC5).

import { describe, expect, it } from 'vitest';

import type { EngineMessage } from './session-engine.js';
import {
  MAX_TEXT_CHARS,
  MAX_TOOL_INPUT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  normalizeMessage,
} from './transcript-events.js';

describe('normalizeMessage', () => {
  describe('system/init', () => {
    it('maps system/init to a single frozen init body', () => {
      const result = normalizeMessage({ type: 'system', subtype: 'init', session_id: 'sdk-1' });

      expect(result).toEqual([{ kind: 'init' }]);
      expect(Object.isFrozen(result[0])).toBe(true);
    });

    it('ignores a system message with a non-init subtype', () => {
      expect(normalizeMessage({ type: 'system', subtype: 'compact_boundary' })).toEqual([]);
    });
  });

  describe('assistant messages', () => {
    it('maps text and tool_use blocks preserving block order', () => {
      const message: EngineMessage = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking about it' },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
            { type: 'text', text: 'done' },
          ],
        },
      };

      const result = normalizeMessage(message);

      expect(result).toEqual([
        { kind: 'assistant-text', text: 'thinking about it' },
        { kind: 'tool-use', toolName: 'Bash', toolInput: '{"command":"ls"}', toolUseId: 'tu-1' },
        { kind: 'assistant-text', text: 'done' },
      ]);
      expect(result.every((body) => Object.isFrozen(body))).toBe(true);
    });

    it('truncates assistant text to MAX_TEXT_CHARS', () => {
      const message: EngineMessage = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x'.repeat(MAX_TEXT_CHARS + 100) }] },
      };

      const [body] = normalizeMessage(message);

      expect(body).toMatchObject({ kind: 'assistant-text' });
      expect((body as { text: string }).text).toHaveLength(MAX_TEXT_CHARS);
    });

    it('truncates tool input to MAX_TOOL_INPUT_CHARS and nulls a missing id', () => {
      const message: EngineMessage = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Write', input: { blob: 'y'.repeat(5000) } }],
        },
      };

      const [body] = normalizeMessage(message);

      expect(body).toMatchObject({ kind: 'tool-use', toolName: 'Write', toolUseId: null });
      expect((body as { toolInput: string }).toolInput).toHaveLength(MAX_TOOL_INPUT_CHARS);
    });

    it('skips malformed blocks and a tool_use without a name', () => {
      const message: EngineMessage = {
        type: 'assistant',
        message: {
          content: [
            null,
            'a bare string',
            { type: 'tool_use', input: {} },
            { type: 'text', text: 'kept' },
          ],
        },
      };

      expect(normalizeMessage(message)).toEqual([{ kind: 'assistant-text', text: 'kept' }]);
    });

    it('returns [] when the assistant message has no content array', () => {
      expect(normalizeMessage({ type: 'assistant' })).toEqual([]);
      expect(normalizeMessage({ type: 'assistant', message: { content: 'hi' } })).toEqual([]);
      expect(normalizeMessage({ type: 'assistant', message: null })).toEqual([]);
    });
  });

  describe('user messages', () => {
    it('maps tool_result blocks with id, content, and is_error', () => {
      const message: EngineMessage = {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file written', is_error: false },
            { type: 'tool_result', content: [{ type: 'text', text: 'boom' }], is_error: true },
          ],
        },
      };

      const result = normalizeMessage(message);

      expect(result).toEqual([
        { kind: 'tool-result', toolUseId: 'tu-1', content: 'file written', isError: false },
        {
          kind: 'tool-result',
          toolUseId: null,
          content: '[{"type":"text","text":"boom"}]',
          isError: true,
        },
      ]);
      expect(result.every((body) => Object.isFrozen(body))).toBe(true);
    });

    it('truncates tool-result content to MAX_TOOL_RESULT_CHARS', () => {
      const message: EngineMessage = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: 'z'.repeat(MAX_TOOL_RESULT_CHARS + 1) }],
        },
      };

      const [body] = normalizeMessage(message);

      expect((body as { content: string }).content).toHaveLength(MAX_TOOL_RESULT_CHARS);
    });

    it('ignores the plain-string kickoff user message', () => {
      expect(
        normalizeMessage({ type: 'user', message: { role: 'user', content: 'kick off the task' } }),
      ).toEqual([]);
    });

    it('ignores non-tool_result blocks in a user message', () => {
      expect(
        normalizeMessage({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
      ).toEqual([]);
    });
  });

  describe('result messages', () => {
    it('maps all result metrics as a single frozen result body', () => {
      const message: EngineMessage = {
        type: 'result',
        duration_ms: 1234,
        num_turns: 3,
        total_cost_usd: 0.42,
        usage: { input_tokens: 100, output_tokens: 200 },
        is_error: false,
      };

      const result = normalizeMessage(message);

      expect(result).toEqual([
        {
          kind: 'result',
          durationMs: 1234,
          numTurns: 3,
          totalCostUsd: 0.42,
          inputTokens: 100,
          outputTokens: 200,
          isError: false,
        },
      ]);
      expect(Object.isFrozen(result[0])).toBe(true);
    });

    it('coerces missing and non-number metric fields to 0', () => {
      const result = normalizeMessage({
        type: 'result',
        duration_ms: 'fast' as unknown as number,
        usage: { input_tokens: NaN },
      });

      expect(result).toEqual([
        {
          kind: 'result',
          durationMs: 0,
          numTurns: 0,
          totalCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          isError: false,
        },
      ]);
    });

    it('coerces is_error: only literal true counts', () => {
      const [body] = normalizeMessage({ type: 'result', is_error: true });
      expect(body).toMatchObject({ kind: 'result', isError: true });

      const [notError] = normalizeMessage({
        type: 'result',
        is_error: 'yes' as unknown as boolean,
      });
      expect(notError).toMatchObject({ kind: 'result', isError: false });
    });
  });

  describe('unknown / malformed input', () => {
    it('returns [] for unknown message types', () => {
      expect(normalizeMessage({ type: 'stream_event' })).toEqual([]);
      expect(normalizeMessage({ type: 'frobnicate' })).toEqual([]);
    });

    it('never throws on garbage input', () => {
      const cyclic: Record<string, unknown> = { type: 'assistant' };
      const cyclicInput: Record<string, unknown> = {};
      cyclicInput['self'] = cyclicInput;
      cyclic['message'] = { content: [{ type: 'tool_use', name: 'Bash', input: cyclicInput }] };

      const inputs: unknown[] = [
        null,
        undefined,
        42,
        'a string',
        {},
        { type: 42 },
        { type: 'assistant', message: 7 },
        { type: 'user', message: { content: [Symbol('x')] } },
        { type: 'result', usage: 'nope' },
        cyclic,
      ];

      for (const input of inputs) {
        expect(() => normalizeMessage(input as EngineMessage)).not.toThrow();
      }
      // Cyclic tool input stringifies to '' rather than throwing.
      expect(normalizeMessage(cyclic as unknown as EngineMessage)).toEqual([
        { kind: 'tool-use', toolName: 'Bash', toolInput: '', toolUseId: null },
      ]);
      expect(normalizeMessage(null as unknown as EngineMessage)).toEqual([]);
      expect(normalizeMessage(undefined as unknown as EngineMessage)).toEqual([]);
    });
  });
});
