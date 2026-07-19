# Driving and Observing Claude Code Sessions — Development OS

Research for the "Development OS" wayfinder map (local web app = mission-control over local coding
projects and their Claude Code agent sessions).

**Question:** What is the right mechanism for a local server to (a) start a session in a project dir,
(b) send follow-up steering input, (c) observe live state for a dashboard, and (d) detect
"blocked / needs human input"? Compare Agent SDK vs headless `claude -p` vs PTY/tmux vs
transcript-file reading on control, observability, robustness, and implementation cost.

---

## Scope

- IN: mechanism to spawn/steer/observe Claude Code sessions from a local server; observable session
  state (running/blocked/waiting, current tool, tokens/cost, last output); the four candidates and a
  recommendation.
- OUT: the dashboard UI, auth/multi-user, remote/cloud hosting, non-Claude agents.

---

## Key findings

### The four mechanisms are really two engines + two file/UI taps

- The Agent SDK and `claude -p` are the **same engine** — "the Agent SDK via the CLI"; the SDK gives
  "the same tools, agent loop, and context management that power Claude Code" as CLI, Python, or
  TypeScript. [CITED: https://code.claude.com/docs/en/headless]
- PTY/tmux and transcript-file reading are **taps on a session someone else drives**, not drivers.
  A transcript is read-only; a PTY scrapes a human TUI. [ASSUMED — inference from the mechanisms; the
  read-only nature of transcripts is confirmed below]

### 1. Agent SDK (TypeScript `query()` / Python `ClaudeSDKClient`) — recommended driver

- Installed as `npm install @anthropic-ai/claude-agent-sdk` / `pip install claude-agent-sdk`
  (Python 3.10+). [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]
- **Streaming input mode is the documented preferred mode** and provides "full access to the agent's
  capabilities" and "rich, interactive experiences"; it is the mode that supports dynamic message
  queueing and real-time interruption. Single-message mode is one-shot.
  [CITED: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode]
- **(a) Spawn:** TS `query({ prompt, options })` where `prompt` is `string | AsyncIterable<SDKUserMessage>`;
  Python `ClaudeSDKClient(options)` as an async context manager. Set the project dir via options (cwd).
  [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]
- **(b) Steer:** yield more `SDKUserMessage` objects into the async input stream; `Query.interrupt()`
  (streaming mode only); `Query.setPermissionMode()` / `Query.setModel()`.
  [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]
- **(d) Blocked detection (best):** `options.canUseTool(request) => Promise<ToolPermissionResult>` is a
  callback fired exactly when a tool would otherwise prompt — the OS renders the "allow this tool?"
  dialog in the browser and returns the decision. This is the cleanest programmatic "needs human"
  signal and has no equivalent in `-p`. [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]
- **(c) Observe:** the SDK emits native message objects (`system/init`, `assistant`, `user`,
  `stream_event`, `result`) — same event set as `stream-json` below.
  [CITED: https://code.claude.com/docs/en/headless]
- `startup()` pre-warms the CLI subprocess (spawn + initialize handshake) so the first `query()` skips
  spawn/init latency — useful when a dashboard spawns sessions on demand.
  [CITED: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md]
- Note: the unstable V2 session API (`unstable_v2_createSession` / `_resumeSession` / `_prompt`) was
  deprecated in the TS SDK — use `query()`. Do not build on V2. [CITED: same CHANGELOG]

### 2. Headless `claude -p` with `--output-format stream-json` — language-agnostic driver

- **(a) Spawn:** `claude -p "<prompt>" [flags]` runs the same agent loop non-interactively and exits;
  all CLI options work. `--bare` skips auto-discovery of hooks/skills/MCP/CLAUDE.md and will become the
  `-p` default. [CITED: https://code.claude.com/docs/en/headless]
- **(c) Observe:** `--output-format stream-json` emits NDJSON, one event per line; **requires
  `--verbose`**, and token deltas additionally require `--include-partial-messages`.
  [CITED: https://code.claude.com/docs/en/headless]
- Event types on the stream: `system` (incl. `system/init` with model/tools/MCP/plugins and an optional
  `capabilities` array for feature-detection, and `system/api_retry` with `attempt`/`max_retries`/
  `retry_delay_ms`/`error`), `assistant`, `user`, `stream_event`, and a final `result` line with
  response text, cost, and session metadata. Subagent messages carry `parent_tool_use_id`; main
  conversation carries `null`. [CITED: https://code.claude.com/docs/en/headless]
- **Tokens/cost:** `--output-format json` payload includes `total_cost_usd` and a per-model cost
  breakdown; the `stream-json` `result` line carries cost + session metadata.
  [CITED: https://code.claude.com/docs/en/headless]
- **Resume:** `--continue` (most recent in cwd) or `--resume <session-id>`; session-ID lookup is scoped
  to the current project dir and its git worktrees. Capture the ID via
  `claude -p ... --output-format json | jq -r '.session_id'`. [CITED: https://code.claude.com/docs/en/headless]
- **(b) Steer / (d) blocked:** the headless docs page does NOT document a bidirectional
  `--input-format stream-json` stdin channel or a `canUseTool`-equivalent. In `-p` you either
  pre-authorize with `--allowedTools` / `--permission-mode` (e.g. `dontAsk`, `acceptEdits`) or rely on
  hooks; mid-turn steering means resuming with a new `-p` call, not injecting into a live turn.
  [CITED: https://code.claude.com/docs/en/headless] Interactive per-tool approval is therefore weaker
  than the SDK. A `--input-format stream-json` flag exists in the wild but is not on the official
  headless page. [ASSUMED — needs confirmation; not found in current official docs this pass]
- **Lifecycle detail:** SIGTERM to a `-p` run aborts the turn, kills the Bash process tree, runs
  `SessionEnd` hooks, exits 143; background bash tasks are killed ~5s after the final result.
  [CITED: https://code.claude.com/docs/en/headless]

### 3. PTY / tmux wrapping of the interactive TUI

- Run the real `claude` TUI under a pseudo-terminal (e.g. `node-pty`) and scrape the rendered buffer.
  **Steer** = write keystrokes (Enter, Esc-to-interrupt, arrows for the permission dialog); fully
  general. **Observe** = only the rendered terminal text; "blocked" = pattern-matching prompt/ANSI;
  tokens/cost only if shown on a status line. [ASSUMED — mechanics of PTY scraping; needs confirmation
  of Claude-specific TUI markers]
- It is the only way to mirror/attach to a genuinely interactive human TUI session, but it parses a
  human-facing UI, so it is the most fragile and carries no structured cost/token data. [ASSUMED]

### 4. Reading session/transcript JSONL (passive observation)

- Hooks receive a `transcript_path` pointing to the conversation JSON, so the OS can locate and tail
  the live transcript per session. [CITED: https://code.claude.com/docs/en/hooks]
- **Official warning against parsing it as a data contract:** Anthropic steers integrators to `/export`
  or the script interfaces rather than reading transcript entries directly, because the entry format is
  internal and changes between versions. Treat any direct parse as best-effort.
  [ASSUMED — strongly implied by docs steering to `/export` and hooks; exact "changes between versions"
  wording needs confirmation from the Sessions page, not re-fetched this pass]
- Transcripts live under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (relocatable via
  `CLAUDE_CONFIG_DIR`). [ASSUMED — widely reported; needs confirmation against current Sessions doc]
- **Cannot steer** (read-only) and **cannot cleanly show "blocked-for-input"** — nothing is written
  while a session waits, so blocked-state must come from hooks. [ASSUMED]

### Hooks — the machine-wide event bus for observability + blocked-detection

- Every hook receives on stdin: `session_id`, `transcript_path`, `cwd`,
  `permission_mode` (`default`/`plan`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`),
  `hook_event_name`, plus tool events add `tool_name` / `tool_input`; subagent context adds
  `agent_id`/`agent_type`. [CITED: https://code.claude.com/docs/en/hooks]
- **Blocked / needs-input signals:** `PermissionRequest` fires when a permission dialog appears;
  `Notification` fires with matcher values including `permission_prompt`, `idle_prompt`,
  `agent_needs_input`, `agent_completed`, `elicitation_dialog`; `Elicitation` fires when an MCP server
  requests input. These are the crisp "light up the badge" triggers — and they fire for sessions the OS
  did NOT spawn. [CITED: https://code.claude.com/docs/en/hooks]
- Lifecycle for a live dashboard: `SessionStart`/`SessionEnd` (appears/disappears),
  `UserPromptSubmit` (turn began), `PreToolUse`/`PostToolUse`/`PostToolUseFailure` (current tool +
  result), `SubagentStart`/`SubagentStop`, `Stop`/`StopFailure` (turn done). [CITED: https://code.claude.com/docs/en/hooks]

### This repo already does spawn-via-`-p` + observe-via-hooks (precedent)

- The Ralph loop / `ralph-prd` skill spawns a fresh `claude -p` per iteration that implements a story,
  runs its verify command, commits on pass, and terminates on `<promise>COMPLETE</promise>` or `--max`.
  [VERIFIED: codebase — skills/ralph-prd/SKILL.md:314,325]
- Observability precedent is hook-based: `hooks/safety-check.js` is a `PreToolUse` hook reading
  `input.tool_name` / `input.tool_input` and can `exit 2` + `decision:deny`; `hooks/session-context.js`
  (`SessionStart`) and `hooks/session-log.js` (`SessionEnd`) read `input.session_id` / `input.matcher`
  and derive per-session outcome metrics from `tasks/metrics.jsonl`.
  [VERIFIED: codebase — hooks/safety-check.js:116-117, hooks/session-context.js:31-33, hooks/session-log.js:76-105]
- Installed settings register `PreToolUse` (matcher `Bash|Write`), `SessionStart`, and `SessionEnd`
  hook groups. [VERIFIED: codebase — install/lib/substitution.js:68-86, .claude/settings.json:3,49]

---

## Comparison

| Criterion | Agent SDK (streaming) | `claude -p` stream-json | PTY / tmux | Transcript JSONL |
|---|---|---|---|---|
| (a) Spawn in project dir | Native (cwd option) [CITED] | Native (cwd of process) [CITED] | Native (spawn TUI) [ASSUMED] | N/A — read-only [ASSUMED] |
| (b) Steer live | Best: yield msgs, `interrupt()`, `setPermissionMode` [CITED] | Weak: resume with new `-p` call; no documented live stdin [CITED] | General: keystrokes [ASSUMED] | None [ASSUMED] |
| (c) Observe (tool/tokens/cost) | Native typed msgs; `result.usage`/cost [CITED] | Same events as NDJSON; `result` cost [CITED] | Scrape only; no structured cost [ASSUMED] | Best-effort parse; no live blocked-state [ASSUMED] |
| (d) Blocked / needs-input | Best: `canUseTool` callback [CITED] | Hooks only [CITED] | Pattern-match prompt text [ASSUMED] | Not observable — pair with hooks [ASSUMED] |
| Robustness / contract | Highest: versioned typed API [CITED] | High: documented NDJSON events [CITED] | Lowest: human-TUI scraping [ASSUMED] | Low: internal format, "use `/export` instead" [ASSUMED] |
| Implementation cost | Low-med (Node/Python host) | Med (subprocess + NDJSON buffering) | High (PTY + parser) | Low to tail, high to trust |
| Sessions it can see | Only ones OS spawns | Only ones OS spawns | Attach to a human TUI | Any session on the machine |

---

## Recommendation

**Hybrid, SDK-primary:**

1. **Drive owned sessions with the Agent SDK in streaming-input mode** — one long-lived `query()` (TS)
   or `ClaudeSDKClient` (Py) per session, many multiplexed behind the local server, fanned out to the
   browser over WebSocket. It is the only candidate that natively does spawn + live steer + interrupt +
   programmatic permission approval (`canUseTool`). Use `startup()` to hide spawn latency.
2. **Observe those sessions from the SDK's own message stream** (`system/init` -> `assistant`/`user`/
   `stream_event` -> `result`). Derive: running = messages since last `result`; idle = last event was
   `result`; blocked = `canUseTool` pending. Current tool = `assistant` `tool_use` block; todos =
   `TodoWrite` tool input; tokens/cost = `result` usage + `total_cost_usd`.
3. **Layer hooks as a machine-wide event bus** (POST to a local endpoint) — chiefly `Notification`
   (`permission_prompt`/`idle_prompt`/`agent_needs_input`) for a crisp "needs you" badge, plus
   `SessionStart`/`SessionEnd`. This is the ONLY way to also observe sessions the OS didn't spawn
   (a human's terminal). This repo already proves the hook path works.
4. **Use transcript JSONL only as a best-effort read-only view of foreign sessions**, behind an adapter,
   defensively parsed. Never the core contract.
5. **`claude -p` stream-json is the fallback driver** if the host server is not Node/Python, accepting
   weaker live-steering. **PTY/tmux only** as an optional "attach to a human's real terminal" pane.

**Why:** the SDK gives a stable, typed, fully-steerable contract for sessions the OS owns; hooks +
transcript extend observation to sessions it doesn't own at best-effort reliability; the two file/UI
taps are fragile and belong on the periphery, matching what Anthropic's own docs steer toward.

---

## Gotchas

- **SDK/`-p` sessions are headless and non-attachable** — they don't join the interactive `--resume`
  picker and have no TUI, so the OS becomes the SOLE interface for every session it spawns (must
  implement input box, interrupt, and permission dialogs). [ASSUMED — needs confirmation from Sessions doc]
- `stream-json` output silently gives nothing useful without `--verbose`; token deltas need
  `--include-partial-messages`. [CITED: https://code.claude.com/docs/en/headless]
- Before v2.1.208 a large piped response could truncate the final `result` line. Feature-detect via
  `system/init.capabilities`, not version strings. [CITED: https://code.claude.com/docs/en/headless]
- `--bare` (recommended for scripted/SDK calls) skips OAuth/keychain — auth must come from
  `ANTHROPIC_API_KEY` or an `apiKeyHelper`, and it will NOT load project hooks/MCP/CLAUDE.md. Decide per
  session whether the OS wants the local context loaded or a reproducible bare run.
  [CITED: https://code.claude.com/docs/en/headless]
- Transcript JSONL never writes while a session is blocked-for-input, so "waiting for you" is NOT
  derivable from the file — it must come from `canUseTool` or the `Notification`/`PermissionRequest`
  hooks. [ASSUMED]
- Hooks only fire if the user's settings register them; a dashboard that depends on hooks must install
  its own hook config. [CITED: https://code.claude.com/docs/en/hooks — hooks are settings-configured]

---

## Code patterns to follow

- One SDK session object per Claude Code session; multiplex many in one server process; WebSocket to the
  browser. [ASSUMED — architecture inference]
- Derive dashboard state from stream events, not by polling files. [CITED: headless event model]
- Route "blocked/needs-input" through `canUseTool` (owned sessions) + `Notification` hook (all sessions).
  [CITED: agent-sdk/typescript + hooks]
- Reuse this repo's hook pattern: small Node hook reads stdin JSON (`session_id`, `tool_name`,
  `transcript_path`), does one job, exits fast, fail-open. [VERIFIED: codebase — hooks/*.js]
- Feature-detect with `system/init.capabilities`; keep any transcript parsing behind an isolated adapter.
  [CITED: headless]

## Code patterns to avoid

- Do NOT make raw JSONL transcript tailing the primary/steering mechanism — internal format, Anthropic
  steers to `/export`/SDK. [ASSUMED — confirm exact wording]
- Do NOT scrape the TUI via PTY as the structured data source (no reliable tokens/cost, breaks on TUI
  redesign). [ASSUMED]
- Do NOT build on the deprecated TS `unstable_v2_*` session API — use `query()`.
  [CITED: claude-agent-sdk-typescript CHANGELOG]
- Do NOT assume `-p` can inject input into a live turn; treat `-p` steering as resume-with-new-call.
  [CITED: headless — no documented live stdin]

---

## Links

| Topic | URL | Tag |
|---|---|---|
| Headless / `claude -p` / stream-json / resume / cost | https://code.claude.com/docs/en/headless | CITED |
| Agent SDK — TypeScript reference (`query`, `canUseTool`, `interrupt`) | https://code.claude.com/docs/en/agent-sdk/typescript | CITED |
| Agent SDK — Python reference | https://platform.claude.com/docs/en/agent-sdk/python | CITED |
| Streaming vs single mode (preferred streaming input) | https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode | CITED |
| Hooks reference (events, Notification matchers, input fields) | https://code.claude.com/docs/en/hooks | CITED |
| TS SDK CHANGELOG (`startup()`, V2 deprecation) | https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md | CITED |
| Manage sessions (transcript path, resume scope, format warning) | https://code.claude.com/docs/en/sessions | ASSUMED (not re-fetched this pass) |
| Repo precedent — Ralph loop spawns `claude -p` | skills/ralph-prd/SKILL.md:314,325 | VERIFIED |
| Repo precedent — hooks observe sessions | hooks/safety-check.js, session-context.js, session-log.js; install/lib/substitution.js:68-86 | VERIFIED |

---

## Assumed claims requiring confirmation

1. `--input-format stream-json` bidirectional stdin exists for `-p` — NOT found on the current official
   headless page this pass. Confirm before relying on live `-p` steering. [ASSUMED]
2. Transcript path `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` and the exact "format is
   internal / changes between versions" wording — from the Sessions doc, not re-fetched this pass.
   Confirm against https://code.claude.com/docs/en/sessions.
3. SDK/`-p` sessions are non-attachable / absent from the interactive `--resume` picker — plausible and
   consistent with headless design, but confirm on the Sessions doc before designing the "OS is the sole
   UI" constraint into the product.
4. PTY/tmux specifics (which ANSI/prompt markers reliably indicate "blocked") — no Claude-specific source
   found; would need a spike if PTY attach is pursued.
5. `canUseTool` covers all interactive-input cases (incl. `AskUserQuestion` / MCP `requiresUserInteraction`)
   — stated in prior research but verify against the current TS reference before treating it as the sole
   blocked-detection path for owned sessions.
