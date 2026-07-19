# Research: Prior-art multi-agent / Claude-Code control UIs (Dev OS map, ticket B)

**Date:** 2026-07-18
**Researcher:** Claude Code (/research skill, wayfinder ticket B)
**Status:** Draft — review before relying on [ASSUMED] claims

---

## Scope

Survey of existing tools that observe and drive Claude Code (and sibling CLI agents) so we
can decide, for the "Development OS" map — a local-only, many-projects mission-control web
app over a developer's local repos and their Claude Code sessions — whether to fork/adopt an
existing tool or build from scratch and borrow their patterns. Tools reviewed: Conductor,
Vibe Kanban, Crystal (now Nimbalyst), claude-squad, Omnara, with brief notes on adjacent
tools. For each: purpose, how it spawns/steers/observes CC sessions, worktree/tmux/SDK usage,
local-vs-cloud, tech stack, main-screen UI pattern, and license (fork-ability).

---

## Key findings

1. **Two dominant isolation primitives: git worktree + a session driver.** Every serious tool
   isolates each agent in its own git worktree/branch, then drives the agent through either a
   PTY/terminal, tmux, or a headless CLI/SDK wrapper. Worktree-per-agent is effectively the
   industry-standard substrate. [VERIFIED: web search across all 5 tools + Claude Code docs]
   [CITED: https://code.claude.com/docs/en/worktrees]

2. **Conductor** — proprietary macOS app (YC S24, Charlie Holtz / Jackson de Campos) that runs
   parallel Claude Code, Codex, and Cursor agents, each in its own isolated workspace (git
   worktree) with its own branch/state; integrates GitHub (open PRs, read diffs, respond to
   review comments) and Linear (pull a ticket into a workspace as task description). Free but
   **closed-source** (cannot fork), macOS-Apple-Silicon only, local (no cloud); reuses your
   existing Claude/Codex login (no API key taken). Main screen = workspace overview ("see at a
   glance what each agent is working on"). [CITED: https://www.conductor.build/]
   [CITED: https://parallelcode.app/compare/parallel-code-vs-conductor/]

3. **Vibe Kanban (BloopAI)** — open-source (**Apache-2.0**) local-first orchestrator: `npx
   vibe-kanban` runs a local Rust server that opens a browser web UI; optional Docker
   self-host. Each task runs in its own git worktree and gets "a branch, a terminal, and a dev
   server"; supports 10+ agents (Claude Code, Codex, Gemini CLI, Copilot, Amp, Cursor,
   OpenCode, Droid, CCR, Qwen). Main screen = **Kanban board** for planning + separate
   workspaces for execution; review is syntax-highlighted diffs with inline comments that feed
   back to the agent. Stack: Rust backend + TypeScript/React frontend + PostgreSQL. **Repo
   shows a sunset/no-longer-actively-maintained notice.** [CITED: https://github.com/BloopAI/vibe-kanban]

4. **Crystal (stravu)** — MIT-licensed Electron desktop app ("first Integrated Vibe
   Environment") that runs multiple Claude Code + Codex sessions in parallel git worktrees to
   test/compare approaches side by side; TypeScript-heavy (~97%), Monaco editor, local-first
   file model. Visual indicators show session state (initializing / running / waiting-for-input
   / completed), plus prompt history and session templates. **Deprecated Feb 2026, succeeded by
   Nimbalyst** (a broader visual workspace). Exact session driver (PTY vs SDK) not documented in
   the sources read. [CITED: https://github.com/stravu/crystal]
   [CITED: https://nimbalyst.com/crystal/]

5. **claude-squad (smtg-ai)** — AGPL-3.0 Go terminal app (`cs`) managing multiple Claude Code,
   Codex, Gemini, Aider, and custom agents. Isolation = **tmux** (isolated terminal session per
   agent) + **git worktree** (branch per task). Main screen = **TUI dashboard/list** of sessions
   driven by keyboard shortcuts (n=new, j/k=nav, ↵=attach, s=commit/push); preview + diff tabs;
   supports background auto-accept for unattended runs. Requires tmux + gh CLI. AGPL copyleft is
   a fork/redistribution constraint. [CITED: https://github.com/smtg-ai/claude-squad]

6. **Omnara (YC S25)** — Apache-2.0 but **cloud-hosted relay** model: Python 3.10+ backend +
   PostgreSQL central API server, React Native mobile apps (iOS/Android) + web dashboard. Drives
   Claude Code by **wrapping the CLI + MCP** (standard/headless/server modes); a server endpoint
   can launch CC instances remotely. Main screen = **unified real-time "Agent Activity Feed"**:
   watch every step, get push/SMS/email notifications when an agent needs input, reply/redirect
   mid-task from phone, web, or Apple Watch. Optimized for remote control, not local
   many-repo overview. **Repo archived Feb 2, 2026; company pivoted to a voice-first platform.**
   [CITED: https://github.com/omnara-ai/omnara]

7. **Closest to our destination = Vibe Kanban + Conductor.** Both are local, multi-project,
   many-agent, worktree-isolated, with a rich browser/desktop overview screen. Vibe Kanban is
   the closest *open* prior art (local server + browser UI, Apache-2.0) but is sunset; Conductor
   is the closest *product* vision but closed-source and Mac-only. Omnara is architecturally
   opposite (cloud relay, remote-first) but has the best "unified inbox / needs-your-input"
   pattern. [VERIFIED: synthesis of findings 2-6]

---

## Comparison table

| Tool | Purpose (1-line) | Session driver | Isolation | Local vs cloud | Stack | Main screen | License | Fork-able? | Status |
|---|---|---|---|---|---|---|---|---|---|
| **Conductor** | Parallel CC/Codex/Cursor agents on your Mac | CLI, reuses local login | git worktree per workspace | Local (macOS AS only) | Not disclosed (native Mac app) | Workspace overview grid | Proprietary, free | No (closed) | Active (v0.76) |
| **Vibe Kanban** | Kanban command-center for 10+ coding agents | branch + terminal + dev server per task | git worktree | Local server + browser (Docker opt.) | Rust + TS/React + Postgres | **Kanban board** + workspaces | Apache-2.0 | Yes | **Sunset** |
| **Crystal / Nimbalyst** | Run/compare parallel CC + Codex sessions | not documented (Electron-driven) | git worktree | Local desktop (Electron) | TS (~97%), Monaco | Session list + state badges + diff | MIT | Yes | **Deprecated → Nimbalyst** |
| **claude-squad** | TUI to manage many terminal agents | **tmux** attach | tmux + git worktree | Local terminal | Go (~90%) | **TUI dashboard/list** | AGPL-3.0 | Yes (copyleft) | Active |
| **Omnara** | Talk to / control your agents from anywhere | CLI wrap + **MCP**; headless/server modes | (relies on agent's own) | **Cloud relay** + mobile/web | Python + Postgres + RN | **Unified activity feed / inbox** | Apache-2.0 | Yes | **Archived Feb 2026** |

---

## Gotchas

- Three of the five reference tools are already end-of-life or renamed: Vibe Kanban sunset,
  Crystal deprecated (→ Nimbalyst), Omnara archived. Forking a dead repo inherits an unmaintained
  base. [CITED: repo notices, findings 3/4/6]
- claude-squad is **AGPL-3.0** — network/redistribution copyleft; forking into a product we may
  distribute has license implications. Vibe Kanban (Apache-2.0), Crystal (MIT), Omnara
  (Apache-2.0) are permissive. [CITED: respective repos]
- Conductor is closed-source — patterns are observable but there is no code to adopt.
  [CITED: https://parallelcode.app/compare/parallel-code-vs-conductor/]
- Omnara's architecture is a **cloud relay by design** — the opposite of our local-only
  requirement; adopting its code would mean gutting the relay, not reusing it. [CITED: omnara repo]
- tmux-based drivers (claude-squad) tie you to a terminal multiplexer and `attach` UX — hard to
  surface cleanly in a rich web mission-control screen without a PTY-over-websocket layer. [ASSUMED]
- Crystal/claude-squad/Conductor are Mac/desktop-centric; a from-scratch local **web** app (our
  target) matches Vibe Kanban's local-server-+-browser shape most closely. [VERIFIED: findings 2-6]

---

## Patterns worth borrowing (steal these)

- **Worktree-per-agent isolation** — the universal substrate. Each session = its own git
  worktree + branch + state, so parallel edits never collide. Non-negotiable for a many-projects
  mission-control app. [VERIFIED: all 5 tools + CC docs]
- **Unified inbox / "needs your input" feed** (Omnara) — a single cross-session activity stream
  that surfaces exactly which agent is blocked waiting on a human, with notifications. Best
  answer to "see everything" across many projects. [CITED: omnara repo]
- **Session-state badges** (Crystal) — initializing / running / waiting-for-input / completed at
  a glance; the atomic unit of a fleet/grid view. [CITED: crystal repo]
- **Fleet dashboard/list of live sessions** (claude-squad TUI, Conductor workspace grid) — one
  screen, all agents, quick attach/steer. [CITED: claude-squad + conductor]
- **Diff-review-with-inline-comments that feed back to the agent** (Vibe Kanban) — review AI
  output like a PR, comment inline, comments become the next steering prompt. [CITED: vibe-kanban repo]
- **Bring-your-own-login, no API key taken** (Conductor) — reuse the machine's existing Claude
  Code auth; lowers trust barrier for a local tool. [CITED: conductor.build]
- **One-command local-server-+-browser bootstrap** (Vibe Kanban `npx vibe-kanban`) — the exact
  deployment shape for a local-only web mission-control. [CITED: vibe-kanban repo]

---

## Recommendation: borrow patterns, build from scratch (do NOT fork)

**Build our own local-only spec and steal the patterns above** rather than fork/adopt any single
tool. Rationale:

- The two closest matches are unavailable as a foundation: **Vibe Kanban** (closest open,
  local-server-+-browser, Apache-2.0) is **sunset**, and **Conductor** (closest product vision)
  is **closed-source**. Forking sunset code or an unforkable app both fail. [CITED: findings 2/3]
- **Omnara** is permissive and has the best inbox pattern but is a **cloud relay** — architecturally
  opposed to local-only; it's a pattern donor, not a codebase donor. [CITED: finding 6]
- **claude-squad** is alive and worktree+tmux-solid but is a **Go TUI under AGPL** — wrong UI
  surface (terminal, not web) and a copyleft constraint. [CITED: finding 5]
- Our differentiator — mission-control over *many local projects at once* with spawn/steer/discuss
  — is not the center of gravity of any single tool (each centers one repo or one board). A
  from-scratch spec lets us make many-projects + unified-inbox first-class.

**If forced to fork**, the least-bad base is **Vibe Kanban (Apache-2.0, local server + browser,
Rust+React)** — same deployment shape and permissive license — accepting that it is unmaintained
and would need adoption/hard-fork ownership. **Second look: Nimbalyst** (Crystal's live successor)
if it is open-source — verify before considering (unconfirmed). [ASSUMED]

**Closest prior-art tools to keep as design references:** **amux** (the nearest *architectural*
twin — see merged section below), Vibe Kanban (open, local, kanban+worktree) and Conductor
(product vision for local parallel agents). Borrow Omnara's unified inbox and Crystal's
session-state badges on top.

---

## Additional tools (merged 2026-07-18 from prior research `ticket-2-prior-art.md`)

A prior research pass surfaced four tools this survey missed. Consolidated here so this file is
the single canonical prior-art record. Provenance is the prior file's cited sources (re-verify
before relying).

1. **amux (mixpeek) — nearest architectural twin.** Single-file **Python local web server**
   (inline HTML/CSS/JS) + **tmux 3.2+** + **SQLite**; `amux serve` runs locally, local-first, no
   auth by default ("bind to localhost or use Tailscale"). **Multi-project registry**
   (`amux register <name> --dir <path>` / `start` / `ls`), each project a persistent tmux
   session. Observes by **parsing ANSI-stripped tmux scrollback — "no hooks, no patches, no
   modifications to Claude Code"** — with a **self-healing watchdog** (detects context
   exhaustion, rate-limit prompts, stuck processes and auto-responds/restarts), real-time "peek
   mode" with search, SSE live updates, optional tiled multi-agent view, and a SQLite **kanban
   with atomic claiming**. Conflict-detection instead of mandatory worktree-per-task. License
   **MIT + Commons Clause** (self-host/study freely; resale needs a license → reference
   architecture, not a fork base). Matches almost every Dev OS requirement; **study this first.**
   [CITED: https://github.com/mixpeek/amux]

2. **CCManager (kbwo)** — Node/Ink **TUI** session manager for 8 CLIs across git worktrees and
   **multiple projects** (one of the few genuinely multi-project tools); **explicitly avoids
   tmux**; context-copying carries session data into new worktrees; **status-change hooks** fire
   on session-state changes (a secondary observation channel); devcontainer isolation. Permissive
   (MIT-ish), fork-able. Borrow: multi-project registry model + status-change hook observation.
   [CITED: https://github.com/kbwo/ccmanager]

3. **Claudia / opcode (getAsterisk → winfunc/opcode)** — Tauri 2 + Rust + React **desktop** GUI /
   toolkit: manage sessions, custom agents, **sandboxed background agents** (separate processes),
   usage/cost tracking UI. **AGPL-3.0 — viral, not fork-safe** for a product. Borrow the
   sandboxed-process model + cost-tracking UI, not the code.
   [CITED: https://github.com/getAsterisk/claudia]

4. **Claude Code native — Agent View & Agent Teams** — Anthropic shipped **Agent View**
   (May 2026): a built-in CLI dashboard of all background sessions showing which await input,
   letting you reply/attach without losing context; plus **Agent Teams** (a lead session
   coordinating teammates via a shared task list, each in its own context). **Implication:**
   single-project "steer/discuss agents" is now partly native — Dev OS's differentiating value is
   the **cross-project fleet + unified tracker** layer *above* what Claude Code ships natively.
   [ASSUMED — confirm against current Claude Code release notes]

**Session-model note (prior file's emphasis):** amux, Omnara-v1, and claude-squad converged on
observing via **terminal scrollback + `~/.claude/projects` JSONL** rather than SDK/hooks alone.
This is a viable alternative to ticket A's SDK-primary recommendation for *foreign* (non-OS-spawned)
sessions — reconcile the two when specifying the observation layer.

---

## Links

| Resource | URL | Notes |
|---|---|---|
| Conductor homepage | https://www.conductor.build/ | Proprietary macOS parallel-agent app |
| Conductor vs Parallel Code | https://parallelcode.app/compare/parallel-code-vs-conductor/ | Confirms closed-source, free, Mac-only |
| Vibe Kanban repo | https://github.com/BloopAI/vibe-kanban | Apache-2.0, Rust+React, local server; sunset |
| Crystal repo | https://github.com/stravu/crystal | MIT, Electron; deprecated → Nimbalyst |
| Nimbalyst (Crystal successor) | https://nimbalyst.com/crystal/ | Successor product; OSS status unconfirmed |
| claude-squad repo | https://github.com/smtg-ai/claude-squad | AGPL-3.0, Go TUI, tmux+worktree |
| Omnara repo | https://github.com/omnara-ai/omnara | Apache-2.0, cloud relay; archived Feb 2026 |
| Claude Code worktrees docs | https://code.claude.com/docs/en/worktrees | Official parallel-session guidance |
| amux repo | https://github.com/mixpeek/amux | MIT+Commons Clause; local Python web server, tmux, multi-project — nearest twin |
| CCManager repo | https://github.com/kbwo/ccmanager | MIT-ish; multi-project TUI, status-change hooks, no tmux |
| Claudia / opcode repo | https://github.com/getAsterisk/claudia | AGPL-3.0; Tauri desktop, sandboxed background agents |

---

## Assumed claims requiring confirmation

- [ ] Crystal's exact session driver (PTY vs SDK vs CLI) — not documented in sources read. Verify:
      read stravu/crystal source (main process spawn code).
- [ ] Nimbalyst open-source status and license — unknown. Verify: check nimbalyst.com / any public repo.
- [ ] tmux-in-web-UI friction claim — reasoning, not a cited fact. Verify: prototype a PTY-over-websocket.
- [ ] Conductor's exact isolation primitive is git worktree specifically (vs generic "workspace copy")
      — strongly implied by ecosystem + blogs but not stated on conductor.build itself. Verify: Conductor docs.
- [ ] Whether Vibe Kanban's "sunset" is a hard archive vs slowed maintenance — verify current repo banner.
