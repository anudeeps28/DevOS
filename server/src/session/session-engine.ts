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

import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Role } from './roles.js';
import type { Effort } from './roster-reader.js';
import { MAX_TEXT_CHARS } from './transcript-events.js';

/**
 * The minimal message shape SessionManager reads off a session stream. The real
 * SDK's `SDKMessage` union is a structural supertype of this — every SDK message
 * has a `type`, `system/init` carries `session_id`. Kept loose so fakes are trivial.
 */
export interface EngineMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  /** The real resolved model id the SDK reports on system/init. */
  readonly model?: string;
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
  send(text: string): Promise<void>;
  /** Register a listener fired on every permission request raised by this session. */
  onPermissionRequest(listener: (req: EnginePermissionRequest) => void): void;
  /** Resolve a pending permission request by id. Idempotent no-op for an unknown id. */
  resolvePermission(requestId: string, decision: PermissionDecision): void;
  /** Register a listener fired on every agent-raised operator question. */
  onQuestionRequest(listener: (req: EngineQuestionRequest) => void): void;
  /** Answer a pending agent question by id. Idempotent no-op for an unknown id. */
  answerQuestion(requestId: string, answer: string): void;
  /**
   * End the session at a clean turn boundary: closes the streaming-input queue so the
   * current turn finishes and the generator then returns. Distinct from `interrupt()`,
   * which aborts the current turn immediately.
   */
  end(): void;
}

/** Parameters for spawning one owned session. */
export interface SpawnParams {
  /** Working directory for the session — the project root (SPEC §3, ARCHITECTURE §1). */
  readonly cwd: string;
  /** The session's role identity (Navigator/Shipwright/…). */
  readonly role: Role;
  /** The roster-declared model id for this role (bracketed context-window suffix included). */
  readonly model: string;
  /** The roster-declared effort level for this role. */
  readonly effort: Effort;
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

/** Truncate `text` to at most `max` characters. */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** A permission request raised by a live session, awaiting an operator decision. */
export interface EnginePermissionRequest {
  readonly requestId: string;
  readonly toolUseId: string | null;
  readonly toolName: string;
  readonly title: string | null;
  readonly input: string;
  readonly ts: number;
}

export type PermissionDecision = 'allow' | 'deny' | 'allow-always';

/**
 * Bound on the un-resolved permission queue: a compromised/misbehaving session could
 * raise `canUseTool` requests faster than the operator decides. Cap the backlog so it
 * can't grow without limit — past the cap, new requests are fail-closed (denied).
 */
export const MAX_PENDING_PERMISSIONS = 256;

/** One session's permission broker: bridges the SDK's `canUseTool` callback to a
 * listener-driven request/resolve flow the manager can relay over the wire. */
export interface PermissionBroker {
  readonly canUseTool: CanUseTool;
  onRequest(listener: (req: EnginePermissionRequest) => void): void;
  resolve(requestId: string, decision: PermissionDecision): void;
  denyAll(): void;
}

/** Create a per-session permission broker mirroring `createInputStream`'s push-pull
 * pattern: `canUseTool` parks a resolver per requestId, `resolve` looks it up and
 * settles it, `denyAll` fails closed on teardown. */
export function createPermissionBroker(): PermissionBroker {
  const pending = new Map<string, { resolve: (result: PermissionResult) => void; toolName: string }>();
  let listener: ((req: EnginePermissionRequest) => void) | null = null;

  const canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      if (pending.size >= MAX_PENDING_PERMISSIONS) {
        resolve({ behavior: 'deny', message: 'permission queue full' });
        return;
      }
      pending.set(opts.requestId, { resolve, toolName });
      opts.signal?.addEventListener(
        'abort',
        () => {
          const r = pending.get(opts.requestId);
          if (r !== undefined) {
            pending.delete(opts.requestId);
            r.resolve({ behavior: 'deny', message: 'aborted' });
          }
        },
        // Auto-remove after firing so a fired abort handler doesn't linger on the signal.
        { once: true },
      );
      listener?.({
        requestId: opts.requestId,
        toolUseId: opts.toolUseID ?? null,
        toolName,
        title: opts.title ?? null,
        input: truncate(JSON.stringify(input), MAX_TEXT_CHARS),
        ts: Date.now(),
      });
    });

  return {
    canUseTool,
    onRequest: (l): void => {
      listener = l;
    },
    resolve: (requestId, decision): void => {
      const r = pending.get(requestId);
      if (r === undefined) return;
      pending.delete(requestId);
      if (decision === 'deny') {
        r.resolve({ behavior: 'deny', message: 'Denied by operator' });
        return;
      }
      if (decision === 'allow-always') {
        const updatedPermissions: PermissionUpdate[] = [
          {
            type: 'addRules',
            rules: [{ toolName: r.toolName }],
            behavior: 'allow',
            destination: 'session',
          },
        ];
        r.resolve({ behavior: 'allow', updatedPermissions });
        return;
      }
      r.resolve({ behavior: 'allow' });
    },
    denyAll: (): void => {
      for (const r of pending.values()) {
        r.resolve({ behavior: 'deny', message: 'session ended' });
      }
      pending.clear();
    },
  };
}

/** A decision question raised by a live session, awaiting an operator answer. */
export interface EngineQuestionRequest {
  readonly requestId: string;
  readonly question: string;
  readonly chips: readonly string[];
}

/**
 * Bound on the un-resolved question queue — the exact analog of
 * `MAX_PENDING_PERMISSIONS`: a compromised/misbehaving session could raise `ask_operator`
 * calls faster than the operator answers. Past the cap, new requests fail closed.
 */
export const MAX_PENDING_QUESTIONS = 256;

/** Cap on the number of quick-reply chips carried by one question, and the length of each. */
const MAX_CHIPS = 8;
const MAX_CHIP_LENGTH = 512;
/** Cap on the agent-supplied question text (mirrors the chip-length discipline). */
const MAX_QUESTION_LENGTH = 4096;

// Built from char codes (not a regex literal) so no control-char escape appears in source.
const CONTROL_CHAR_CLASS = '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']';
const SANITIZE_REGEX = new RegExp(CONTROL_CHAR_CLASS, 'g');

/** Strip control chars and cap length/count on the agent-supplied chip list. */
function sanitizeChips(chips: readonly string[] | undefined): readonly string[] {
  if (chips === undefined) return [];
  return chips.slice(0, MAX_CHIPS).map((chip) => truncate(chip.replace(SANITIZE_REGEX, ' '), MAX_CHIP_LENGTH));
}

/** Strip control chars and cap length on the agent-supplied question text — the same
 * boundary hygiene applied to chips (both are agent-controlled and broadcast to every
 * client for display in the inbox). */
function sanitizeQuestion(question: string): string {
  return truncate(question.replace(SANITIZE_REGEX, ' '), MAX_QUESTION_LENGTH);
}

/** One session's question broker: bridges the in-process `ask_operator` MCP tool to a
 * listener-driven request/resolve flow the manager can relay over the wire. */
export interface QuestionBroker {
  readonly mcpServer: ReturnType<typeof createSdkMcpServer>;
  onRequest(listener: (req: EngineQuestionRequest) => void): void;
  answer(requestId: string, answer: string): void;
  failAll(): void;
}

/** Create a per-session question broker mirroring `createPermissionBroker`'s push-pull
 * pattern: the `ask_operator` tool handler parks a resolver per broker-generated
 * requestId, `answer` looks it up and settles it, `failAll` fails closed on teardown. */
export function createQuestionBroker(): QuestionBroker {
  const pending = new Map<string, { resolve: (result: CallToolResult) => void }>();
  let listener: ((req: EngineQuestionRequest) => void) | null = null;

  const askOperatorTool = tool(
    'ask_operator',
    'Ask the human operator a decision question and block until they answer.',
    { question: z.string(), chips: z.array(z.string()).optional() },
    async (args) =>
      new Promise<CallToolResult>((resolve) => {
        if (pending.size >= MAX_PENDING_QUESTIONS) {
          resolve({ content: [{ type: 'text', text: 'question queue full' }], isError: true });
          return;
        }
        const requestId = randomUUID();
        pending.set(requestId, { resolve });
        listener?.({
          requestId,
          question: sanitizeQuestion(args.question),
          chips: sanitizeChips(args.chips),
        });
      }),
  );

  return {
    mcpServer: createSdkMcpServer({ name: 'devos-operator', tools: [askOperatorTool] }),
    onRequest: (l): void => {
      listener = l;
    },
    answer: (requestId, answer): void => {
      const r = pending.get(requestId);
      if (r === undefined) return;
      pending.delete(requestId);
      r.resolve({ content: [{ type: 'text', text: answer }] });
    },
    failAll: (): void => {
      for (const r of pending.values()) {
        r.resolve({ content: [{ type: 'text', text: 'session ended' }], isError: true });
      }
      pending.clear();
    },
  };
}

/** The push-pull queue handed to the SDK's streaming-input `prompt`, plus the
 * `push`/`close` controls that let a live session steer an in-flight turn. */
export interface InputStream {
  readonly stream: AsyncGenerator<SDKUserMessage>;
  push(text: string): void;
  close(): void;
}

function toUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

/**
 * Bound on the un-drained steer queue: a compromised/misbehaving localhost client
 * could push `session-input` frames faster than the SDK drains them (there is no
 * flood-guard on steer — it is a deliberate user action). Cap the backlog so the
 * queue can't grow without limit; pushes past the cap are dropped (oldest kept, so
 * in-order delivery of already-queued steers is preserved).
 */
export const MAX_PENDING_INPUTS = 256;

/**
 * Streaming-input prompt: yield the `initial` kickoff message, then stay OPEN —
 * awaiting and yielding each `push(text)` message in order — and complete only
 * once `close()` is called (draining any still-queued messages first). Using an
 * async-iterable (not a bare string) keeps the session in streaming-input mode,
 * the mode that enables live steering + interrupt.
 */
export function createInputStream(initial: string): InputStream {
  const pending: string[] = [];
  let waitingResolver: (() => void) | null = null;
  let closed = false;

  const wake = (): void => {
    if (waitingResolver !== null) {
      const resolve = waitingResolver;
      waitingResolver = null;
      resolve();
    }
  };

  async function* stream(): AsyncGenerator<SDKUserMessage> {
    yield toUserMessage(initial);
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) {
        yield toUserMessage(next);
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        waitingResolver = resolve;
      });
    }
  }

  return {
    stream: stream(),
    push: (text: string): void => {
      if (closed) return;
      // Fail safe under a push flood: drop rather than grow unbounded.
      if (pending.length >= MAX_PENDING_INPUTS) {
        console.warn('[session] input queue full — dropping steer message');
        return;
      }
      pending.push(text);
      wake();
    },
    close: (): void => {
      closed = true;
      wake();
    },
  };
}

/** Wrap a session's message iteration so the input stream is always closed AND any
 * still-pending permission/question requests are fail-closed when iteration finishes —
 * a torn-down/ended session releases its queues, and `stopAll` still terminates the
 * underlying SDK generator. */
async function* withInputClose(
  messages: AsyncIterable<EngineMessage>,
  input: InputStream,
  broker: PermissionBroker,
  questionBroker: QuestionBroker,
): AsyncGenerator<EngineMessage> {
  try {
    yield* messages;
  } finally {
    input.close();
    broker.denyAll();
    questionBroker.failAll();
  }
}

/**
 * Build the SDK `Options` for one owned session: cwd, scrubbed env, and the role
 * wired into the system prompt, plus the given permission broker's `canUseTool` and
 * the question broker's in-process `ask_operator` MCP server. Deliberately sets NO
 * `permissionMode` — the SDK default is NOT auto-approve.
 */
export function buildSessionOptions(
  { cwd, role, model, effort }: Pick<SpawnParams, 'cwd' | 'role' | 'model' | 'effort'>,
  broker: PermissionBroker,
  questionBroker: QuestionBroker,
): Options {
  return {
    cwd,
    // Scrubbed env — the subprocess gets an allowlist, never the server's full env.
    env: buildSessionEnv(),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: roleAppend(role) },
    canUseTool: broker.canUseTool,
    mcpServers: { 'devos-operator': questionBroker.mcpServer },
    model,
    effort,
  };
}

/**
 * The real-SDK default engine: start a `query()` generator in streaming-input mode
 * with `cwd = project root` and the role wired into the system prompt. Returns the
 * SDK `Query` wrapped so its input queue closes on iteration end, plus `send()` to
 * push a steering message into the open stream and the permission/question brokers'
 * relays.
 */
export const defaultQuery: QueryFn = ({ cwd, role, model, effort, prompt }): EngineSession => {
  const broker = createPermissionBroker();
  const questionBroker = createQuestionBroker();
  const options = buildSessionOptions({ cwd, role, model, effort }, broker, questionBroker);
  const input = createInputStream(prompt);
  const q = query({ prompt: input.stream, options });
  return Object.assign(withInputClose(q, input, broker, questionBroker), {
    interrupt: (): Promise<unknown> => q.interrupt(),
    send: async (text: string): Promise<void> => {
      input.push(text);
    },
    onPermissionRequest: (listener: (req: EnginePermissionRequest) => void): void => {
      broker.onRequest(listener);
    },
    resolvePermission: (requestId: string, decision: PermissionDecision): void => {
      broker.resolve(requestId, decision);
    },
    onQuestionRequest: (listener: (req: EngineQuestionRequest) => void): void => {
      questionBroker.onRequest(listener);
    },
    answerQuestion: (requestId: string, answer: string): void => {
      questionBroker.answer(requestId, answer);
    },
    end: (): void => input.close(),
  });
};
