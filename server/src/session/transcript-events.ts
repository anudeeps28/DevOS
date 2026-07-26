// Transcript normalizer — pure mapping from the loose `EngineMessage` seam to
// typed `TranscriptEventBody` wire values (server/src/ws-protocol.ts is the
// source of truth for the shapes).
//
// Design notes:
//  - Pure + total: no side effects, and NEVER throws — unknown types, malformed
//    shapes, and missing fields all yield `[]` (or safe coerced defaults).
//  - Bounded output: every free-text field is truncated to a per-kind cap so
//    outbound frames stay modest (the WS `maxPayload` cap is inbound-only).
//  - The normalizer emits BODIES only — SessionManager stamps sessionId/seq/ts.

import type { TranscriptEventBody } from '../ws-protocol.js';
import type { EngineMessage } from './session-engine.js';

// Per-kind truncation caps for free-text fields on outbound transcript events.
export const MAX_TEXT_CHARS = 4000;
export const MAX_TOOL_INPUT_CHARS = 2000;
export const MAX_TOOL_RESULT_CHARS = 2000;

/** Truncate `text` to at most `max` characters. */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Coerce an unknown value to a finite number, defaulting to 0. */
function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** JSON-stringify that never throws (cyclic/bigint inputs yield ''). */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : '';
  } catch {
    return '';
  }
}

/** The `content` block array carried by an assistant/user API message, or null. */
function contentBlocks(message: EngineMessage): readonly unknown[] | null {
  const inner = message.message;
  if (typeof inner !== 'object' || inner === null) return null;
  const { content } = inner as Record<string, unknown>;
  return Array.isArray(content) ? content : null;
}

/** Map an assistant message's content blocks to text/tool-use bodies in order. */
function normalizeAssistant(message: EngineMessage): readonly TranscriptEventBody[] {
  const blocks = contentBlocks(message);
  if (blocks === null) return [];

  const bodies: TranscriptEventBody[] = [];
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as Record<string, unknown>;

    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      bodies.push(
        Object.freeze({
          kind: 'assistant-text' as const,
          text: truncate(block['text'], MAX_TEXT_CHARS),
        }),
      );
      continue;
    }

    if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      bodies.push(
        Object.freeze({
          kind: 'tool-use' as const,
          toolName: block['name'],
          toolInput: truncate(safeStringify(block['input']), MAX_TOOL_INPUT_CHARS),
          toolUseId: typeof block['id'] === 'string' ? block['id'] : null,
        }),
      );
    }
  }
  return bodies;
}

/** Map a user message's tool_result blocks (the plain-string kickoff yields []). */
function normalizeUser(message: EngineMessage): readonly TranscriptEventBody[] {
  const blocks = contentBlocks(message);
  if (blocks === null) return [];

  const bodies: TranscriptEventBody[] = [];
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block['type'] !== 'tool_result') continue;

    bodies.push(
      Object.freeze({
        kind: 'tool-result' as const,
        toolUseId: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : null,
        content: truncate(safeStringify(block['content']), MAX_TOOL_RESULT_CHARS),
        isError: block['is_error'] === true,
      }),
    );
  }
  return bodies;
}

/** Map a result message's metrics, coercing missing/non-number fields to 0. */
function normalizeResult(message: EngineMessage): readonly TranscriptEventBody[] {
  const usage =
    typeof message.usage === 'object' && message.usage !== null
      ? (message.usage as Record<string, unknown>)
      : {};
  return [
    Object.freeze({
      kind: 'result' as const,
      durationMs: toNumber(message.duration_ms),
      numTurns: toNumber(message.num_turns),
      totalCostUsd: toNumber(message.total_cost_usd),
      inputTokens: toNumber(usage['input_tokens']),
      outputTokens: toNumber(usage['output_tokens']),
      isError: message.is_error === true,
    }),
  ];
}

/**
 * Normalize one engine message into zero or more transcript event bodies.
 * Unknown types and malformed shapes yield `[]`. Never throws.
 */
export function normalizeMessage(message: EngineMessage): readonly TranscriptEventBody[] {
  try {
    if (typeof message !== 'object' || message === null) return [];

    if (message.type === 'system' && message.subtype === 'init') {
      return [Object.freeze({ kind: 'init' as const })];
    }
    if (message.type === 'assistant') return normalizeAssistant(message);
    if (message.type === 'user') return normalizeUser(message);
    if (message.type === 'result') return normalizeResult(message);
    return [];
  } catch {
    // Defensive belt-and-braces: the normalizer must NEVER throw (AC5).
    return [];
  }
}
