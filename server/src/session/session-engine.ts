// Session engine — the injectable `QueryFn` seam + the real-SDK default adapter.
//
// This is the ONE file that imports `@anthropic-ai/claude-agent-sdk`. Everything
// else (SessionManager, the gateway) depends only on the narrow `EngineSession` /
// `QueryFn` shapes below, so all unit + integration tests inject a deterministic
// FAKE and NEVER call live Claude. The real SDK is exercised only by the opt-in
// live probe (AC5).
//
// Auth: the SDK inherits the CLI's keychain OAuth (Claude subscription) — no API
// key in V1 (VERIFIED — see tasks/notes.md Decision 2026-07-18).

import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Role } from './roles.js';

/**
 * The minimal message shape SessionManager reads off a session stream. The real
 * SDK's `SDKMessage` union is a structural supertype of this — every SDK message
 * has a `type`, `system/init` carries `session_id`. Kept loose so fakes are trivial.
 */
export interface EngineMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  // Loose pass-through fields for the transcript normalizer (transcript-events.ts):
  // assistant/user content rides on `message`, result metrics on the rest. All
  // shape-checking happens in the normalizer — the seam stays structural.
  readonly message?: unknown;
  readonly duration_ms?: number;
  readonly num_turns?: number;
  readonly total_cost_usd?: number;
  readonly usage?: unknown;
  readonly is_error?: boolean;
}

/**
 * A live owned session: an async-iterable of messages plus `interrupt()`. The real
 * SDK `Query` (an `AsyncGenerator<SDKMessage>` with `interrupt()`) satisfies this
 * structurally; a test fake is just an async generator with an `interrupt` method.
 */
export interface EngineSession extends AsyncIterable<EngineMessage> {
  interrupt(): Promise<unknown>;
}

/** Parameters for spawning one owned session. */
export interface SpawnParams {
  /** Working directory for the session — the project root (SPEC §3, ARCHITECTURE §1). */
  readonly cwd: string;
  /** The session's role identity (Navigator/Shipwright/…). */
  readonly role: Role;
  /** The initial prompt that kicks off the session. */
  readonly prompt: string;
}

/**
 * The injectable engine seam. `defaultQuery` (below) is the real-SDK default;
 * SessionManager takes a `QueryFn` and defaults to it. Tests pass a fake.
 */
export type QueryFn = (params: SpawnParams) => EngineSession;

// A spawned session is a `claude` SUBPROCESS. The SDK's `options.env`, when set,
// REPLACES the subprocess environment entirely — so we hand it an allowlist instead
// of leaking the server's full `process.env` (every secret it holds) to an agent that
// has bash + file tools. Mirrors tracker-reader.ts:buildAdapterEnv (the same defense
// for the untrusted tracker adapter). Deliberately EXCLUDES `ANTHROPIC_API_KEY` and
// every other secret: the SDK authenticates via the CLI's keychain OAuth (HOME), not
// an env key — passing a key would also silently switch to metered billing (V1 uses
// the subscription). Verified by the AC5 live probe (real system/init under this env).
const SESSION_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TZ',
  'TMPDIR',
];

// Prefix allowlist for locale/XDG/Claude-config families. NOT `ANTHROPIC_` — no API
// key ever reaches the subprocess (subscription auth only).
const SESSION_ENV_PREFIX_ALLOWLIST: readonly string[] = ['LC_', 'XDG_', 'CLAUDE_'];

/** Build the scrubbed environment handed to the spawned `claude` subprocess. */
function buildSessionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SESSION_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SESSION_ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

/** A one-line role identity appended to the default Claude Code system prompt. */
function roleAppend(role: Role): string {
  return `You are running as the DevOS "${role}" role session for this project stage.`;
}

/**
 * Streaming-input prompt: yield the single kickoff message, then close the input
 * stream. Using an async-iterable (not a bare string) keeps the session in
 * streaming-input mode — the mode that later enables live steering + interrupt
 * (a separate M2 task). Here we send one message and let the turn complete.
 */
async function* kickoffInput(text: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

/**
 * The real-SDK default engine: start a `query()` generator in streaming-input mode
 * with `cwd = project root` and the role wired into the system prompt. Returns the
 * SDK `Query`, which structurally satisfies `EngineSession`.
 */
export const defaultQuery: QueryFn = ({ cwd, role, prompt }): EngineSession => {
  const options: Options = {
    cwd,
    // Scrubbed env — the subprocess gets an allowlist, never the server's full env.
    env: buildSessionEnv(),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: roleAppend(role) },
  };
  return query({ prompt: kickoffInput(prompt), options });
};
