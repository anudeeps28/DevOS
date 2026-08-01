# Development OS — Buildable Spec (V1)

**Status:** Destination artifact of the "Development OS" wayfinder map (`6h6M5cm9WjffWxfg`).
Compiles the resolved decisions (tickets A–H) + the per-project workspace reference design into a spec a build
session can execute without further open decisions.
**Date:** 2026-07-18 · **Revised:** 2026-07-20 (role sessions) · 2026-07-31 (two-session consolidation — §3.1) ·
**Scope:** V1 = local-only, single-user, full control (spawn/steer/discuss).

> Home: this becomes the founding design doc of the **separate `development-os` repo** (built *using*
> this harness — harness installed into its `.claude/`). It is NOT part of the harness repo.
> Reference design mockup: an external clickable HTML prototype, kept locally + `docs/planning/design/reference-design-notes.md`.
> Home-screen prototypes: `docs/planning/design/home-ia/`. Research: `docs/planning/research/`.

---

## 1. What it is

A local web app that is **mission control over all of a developer's local projects and their Claude
Code agent sessions** — see every project, spawn/steer/discuss agent sessions, drive work through the
harness's supervised phase pipeline, all from the browser, machine-local. One instance per machine;
it reaches into each project through that project's own installed harness.

## 2. Architecture (ticket G)

- **Server:** Node.js + TypeScript. Runs the **Claude Agent SDK (TS) in-process** — one `query()`
  streaming-input generator per live session, many multiplexed in the one server process.
- **Frontend:** React + Vite + Tailwind + shadcn/ui. IDE-like shell (activity rail → sidebar panels →
  editor-tab workspace), per the reference design.
- **Transport:** WebSocket (bidirectional) — server→browser stream/state/cost; browser→server steer
  input, interrupts, permission decisions.
- **State store:** SQLite (project registry, layouts, session history, cost ledger). Local-first, no
  external services. (Resolves the "OS state store" fog item.)
- **Terminal:** xterm.js + node-pty ONLY as a secondary "attach to a live/foreign terminal" view; the
  primary session UI is custom React over the SDK message stream.

## 3. Session model — spawn / steer / observe (ticket A)

- **Spawn:** OS-owned sessions via the Agent SDK `query()` in streaming-input mode, cwd = the project
  root. One long-lived generator per session.
- **Steer:** yield `SDKUserMessage` (input), `interrupt()`, `setPermissionMode()`; render permission
  prompts via the `canUseTool` callback (→ the UI's Permission card).
- **Observe (owned sessions):** the SDK typed message stream — `system/init` → `assistant`/`user`/
  `stream_event` → `result`. Derive running/idle/blocked, current tool, todo progress, and
  authoritative tokens/cost/duration from `result`.
- **Observe (foreign sessions the OS didn't spawn):** hooks → a local HTTP endpoint as a machine-wide
  event bus (esp. `Notification`: `permission_prompt`/`idle_prompt`/`agent_needs_input`), plus
  best-effort read-only tailing of `~/.claude/projects/**/*.jsonl` (defensively parsed — internal format).
- **Fallbacks:** `claude -p --output-format stream-json` for any non-Node host path; PTY/tmux only for
  attach-to-human-terminal.
- **Known constraint:** SDK/`-p` sessions are headless & non-attachable → the OS is the **sole UI** for
  every session it spawns; it must fully own input, interrupt, and permission UX.

### 3.1 Two-session orchestration (revision 2026-07-31 — supersedes the 2026-07-20 five-role relay)

The per-work-item pipeline is **two sessions**, spawned in sequence by deterministic server code: one
**build session** and one **fresh adversarial review session**. This supersedes the five-role-session
relay (grill 2026-07-31): real usage data showed the per-stage cold-start overhead (each fresh session
re-reads rules/notes/codebase before working) multiplied cost ~5× per item with no quality gain — the
proven `/implement`/`/story` single-session flow already produces finished work. The clean-context
benefit the relay provided is supplied **upstream instead**: wayfinder/grill/milestone decomposition
writes tasks sized to one context window, each carrying its full context (description + acceptance
criteria). Review independence — the one separation that is load-bearing ("never grade your own
homework") — is preserved as its own fresh session.

- **The Bridge** — unchanged: the OS's deterministic orchestrator (server code, not an agent). Owns
  session sequencing, spawning, gate enforcement, and rework routing. Zero prompting logic.
- **The two sessions** — each a fresh SDK session (cwd = project), roster-declared:

  | Role | Does | Runs (skills) | Model / effort (roster-declared) |
  |---|---|---|---|
  | **builder** | understand → plan → code → test → fix; commits, pushes, drafts the PR body to story files | `/implement`, `/story`, `/run-tasks` | Opus 1M-context / medium |
  | **reviewer** | adversarial review of the finished change — **report-only, never touches code** | evaluation + acceptance + architecture + security review | Opus 1M-context / high |

- **Phases are display metadata, not sessions.** The old role names live on as UI phase labels carried
  in the roster (`phases` list per role): planning→**Navigator**, coding→**Shipwright**,
  testing→**Lookout**, reviewing→**Warden**, shipping→**Harbormaster**. Renaming is a roster data edit.
- **Phase-detection contract — the harness announces.** Each phase's work is done by its own subagent;
  the skill writes a phase marker into the story workspace (`tasks/stories/<id>/`) at subagent
  boundaries. The OS's Story State Reader live-derives the current phase from the marker; the OS never
  learns harness internals.
- **Two agent levels (unchanged).** Sessions are the OS-visible unit; within a session the harness's
  subagents fan out as today. The Fleet UI headlines sessions/phases and expands to inner subagent
  activity — never flattened into one list.
- **Review verdict + rework loop.** Only **BLOCK-tier** findings fail a review; advisory-only passes
  (advisories are appended to the PR body). On fail: the reviewer's findings report → the Bridge
  respawns a **fresh build session** with the report as its work order → a fresh review. **Loop cap
  3**, then Escalation → the pipeline parks in the Needs-you inbox.
- **PR mechanics.** The build session's final act: commit, push, draft the PR body into the story
  files. On a CLEAR verdict the **Bridge mechanically opens the PR** via the project's code-platform
  adapter script, appending review verdicts + advisories. No extra session; the reviewer stays
  report-only.
- **Advance policy — the PR is the single default human gate.** Approval happens upstream at
  task-writing time (description + acceptance criteria); the pipeline runs task → build → review → PR
  without stopping. **Interrupts always break through** — Question / Permission / Escalation /
  `agent_needs_input` pauses the pipeline and lands in the Needs-you inbox; work resumes when
  answered. Optional per-project **plan-gate toggle** (default OFF): the build session pauses once
  after its internal planning phase for approval.
- **Context handling — checkpoint + respawn, never compact.** State is continuously current on disk
  (per-wave checkpointing in `tasks/stories/<id>/` — existing convention). The OS watches token usage
  from the stream; at ~80% of the model's window the Bridge ends the session at a clean boundary and
  respawns a fresh build session that resumes from task + acceptance criteria + state files + code so
  far. ~2 resumes on one task → Escalation ("task too big — split it"). Threshold is
  percentage-based — with the 1M-context model, mid-task respawns are rare by design.
- **Handoff contract = the harness's existing artifacts** (grill-summary, plan/architecture docs,
  `tasks/stories/<id>/` plans, review reports). No new handoff mechanism.
- **Role definitions live in the harness, not the OS.** Each project's `.claude/` roster declares the
  two roles (skills, agent definition, phase labels, **model + effort**); the OS reads and
  orchestrates — **zero role/pipeline logic in DevOS**, mirroring the tracker-adapter pattern (§5).
  Per-project rosters carry the cost policy too (e.g. a budget-tier team declares smaller
  models/windows in *their* roster; no code change). Harness + OS changes ship together.

## 4. Project registry (ticket C)

- **Discovery:** hybrid — scan a configured root (e.g. `~/Programming`) for folders with a `.claude/`
  install, list as candidates; the user explicitly **pins** which to track. Nothing tracked without opt-in.
- **Registry model:** thin anchor, live-derive. Persist ONLY `{path, pinned, displayName, uiPrefs}`.
  All reality — tracker mode (from the project's `.harness-manifest.json`), git state (branch/dirty/
  ahead-behind), active sessions, **lifecycle stage** — is derived fresh each render; never cached, never stale.
- **Birth (new idea / new project):** two home entry points — **"New Idea"** (create a folder) and
  **"Add Project"** (point at an existing folder) — both converge on: shell out to the harness's own
  canonical installer (which owns tracker choice), read the resulting `.harness-manifest.json`, pin the
  folder. **Zero install logic in the OS.** A freshly born project lands at stage **New** and
  auto-launches `/wayfinder` on the idea (the planning session *is* the inception). See ARCHITECTURE.md
  §9.4. *(Resolves the "raw idea has no on-ramp" gap — the registry no longer assumes pre-installed folders.)*

## 5. Tracker integration (ticket E)

- **Surface:** full read + write (unified task view AND create/claim/close/comment).
- **Invocation:** the OS shells out to **each project's own** `.claude/trackers/active/<op>.sh` with
  cwd = that project's root → automatically backend-agnostic (GitHub / Todoist / ADO / local all work,
  zero tracker logic in the OS). Reads fan out across pinned projects; writes are scoped to one project.
- **Performance:** fan out/parallelize reads, cache the unified view (live-derived), use a light retried
  health check rather than a full auth probe per call (a real cost hit observed during research).

## 6. Screens & information architecture (tickets D, F + reference design)

**Home = Projects Grid** (ticket D): the project is the primary atom; each card carries a compressed
mini-fleet strip + next task. **Agent Fleet** and **Tracker Inbox** are first-class peer tabs in the
left rail. A blocked agent is surfaced via a KPI callout + card highlight + a notification that
deep-links into the Fleet tab.

**Project-lifecycle level** (the layer above the per-work-item pipeline — ARCHITECTURE.md §9): each
card shows a **lifecycle stage badge** — one word, 5 states in V1: **New → Decide → Define → Build →
Ship** (the harness's own SDLC phases + a leading "New"; Learn folds into Ship). The badge is a **sticky
high-water mark**, derived live via `max(precedence)` over planning artifacts + git + tracker (never
stored). Each card also carries a **"Kick off next stage"** launcher that starts the next harness skill
for the whole project (New→`/grill-me`; Decide→`/architect`+`/plan`; Define→hands into work-item
`/implement`|`/story`; Ship→`/improve-harness`) — light gating (launching *is* the action; real gates
live inside the skills and the Build work-item loop). This is distinct from work-item **"Assign work"**
(one task into the build pipeline); the **Define→Build** transition is where project-level advance hands
down into "Assign work."

**Open a project → the per-project workspace** (the reference design; the drill-down one level below home):
- **Work-item Detail** — the core screen:
  - **Pipeline timeline:** `Analyze → Plan → Code → Test → Fix → Review → PR` (the harness phases),
    showing current stage + loop number.
  - **Team room:** live transcript bound to the item's local Claude Code session (normal mode, driven
    by harness phase skills). Human steers by messaging the team; replies fold into the next loop.
    *(One component, two bindings: **work-item-scoped** here, and **project-scoped** when a project-level
    "Kick off next stage" launches a planning session — see §6 home + ARCHITECTURE.md §9.3.)*
  - **Human gates:** **Plan gate** (decomposition + files + test strategy → approve · start coding /
    request changes+notes) and **Review gate** (code+tests+security done → approve · open PR / request
    changes). Kick-off = **Assign work** (item pulled from the tracker) → team runs the loop, reports
    at each gate. Nothing advances without an explicit human "go".
  - **Inline interrupt cards** (pause the session until answered): Question, Permission (`canUseTool`),
    Escalation (loop-cap → let debug try / give guidance / take over).
  - Side rail: assigned agents (pause/resume/retry each), branch/files/tests/coverage meta, PR card.
  - Evidence tabs: files changed + test results + PR summary; artifact audit trail (brief/plan/
    test-strategy/evaluation/security-review, Draft→Final).
- **Agents:** the work item's sessions (build / review — §3.1) headlined by their current **phase
  persona** (Navigator/Shipwright/Lookout/Warden/Harbormaster, roster-declared display labels) with
  status + owned artifact; each expands to its internal harness subagents.
- **Board:** kanban across Queued→Planning→Coding→Testing→Review→PR→Merged.
- **Skills panel:** org (read-only, versioned) + local (editable, can override an org skill).

**Cross-cutting:** unified **"Needs you" inbox** (every blocked item, sorted by wait) + OS toast +
status bar. **Cost/usage:** per-item token $ and a cost-today figure.

## 7. Core data flow (kick-off → PR)

1. User pins projects (registry) → Home shows the Projects Grid, live-derived.
2. User opens a project → **Assign work** pulls a task via the project's tracker adapter.
3. The Bridge spawns the **build session** (cwd = project) running the build skill; it fans out its
   own specialist subagents internally, writing phase markers as it goes (§3.1).
4. **Understand → Plan → Code → Test → Fix** (one build session; phases display as Navigator →
   Shipwright → Lookout; optional plan-gate pause) → build commits, pushes, drafts the PR body → the
   Bridge spawns the **review session** (Warden; report-only) → on CLEAR the **Bridge opens the PR**
   (Harbormaster phase) via the project's code-platform adapter; BLOCK findings loop back through a
   fresh build session (cap 3 → escalate). **The PR is the default human gate.**
5. Throughout: SDK stream drives the Team room + pipeline state + cost; hooks/inbox surface any
   Question/Permission/Escalation; the human steers via chat or answers a gate.

## 8. Data model (SQLite, sketch)

- `projects(path PK, display_name, pinned, ui_prefs_json, created_at)`
- `sessions(id PK, project_path FK, work_item_id, sdk_session_id, role, status, current_stage, created_at)`
- `projects` gains `auto_advance` (per-project toggle, default off — §3.1) in `ui_prefs_json`.
- `cost_ledger(id PK, session_id FK, input_tokens, output_tokens, cost_usd, at)`
- `ui_state(key PK, value_json)` — layouts, tab state, last-open.
- Everything project-reality (git, tracker tasks, live session state) is derived at read time, not stored.

## 9. V1 scope vs. deferred

**In V1:** projects grid + per-project workspace, session spawn/steer/observe (SDK+hooks), unified
inbox + notifications, tracker read/write via adapters, the phase pipeline with Plan/Review gates,
inline Question/Permission/Escalation, **two-session orchestration** (the Bridge + roster, PR as the
default gate with optional per-project plan gate, review rework loop — §3.1), Skills panel (view),
cost/usage, SQLite state, **the
project-lifecycle level** (stage badge New→Decide→Define→Build→Ship via the Project Lifecycle Reader,
"Kick off next stage" launcher, and new-idea/add-project birth via the harness installer —
ARCHITECTURE.md §9; includes launching `/improve-harness` at Ship→Learn).

**Deferred (post-V1):** model role-slot routing + provider failover; **automated** retro/lessons
harvesting + integration beyond running `/improve-harness`; reliable Learn-stage detection; how a new
milestone resets the lifecycle high-water mark; document audit trail; multi-user / enterprise framing
(named teammate identities, karma, org-vs-local skill governance, PR-to-shared-skills-repo); mobile /
multi-device; cloud/remote execution.

## 10. No open decisions remain

Every wayfinder ticket from both maps is resolved: the original "Development OS" map (tickets A–H →
§§2–8) plus the follow-on **"project-lifecycle level"** map (`6h6gPPWFfHr5PwG8`, tickets T1–T3 → §4
birth, §6 lifecycle badge + kick-off launcher, and ARCHITECTURE.md §9). The "Not yet specified" fog is
either specified above or explicitly deferred to post-V1 (§9). The §3.1 orchestration model was
revised twice: 2026-07-20 (role sessions, resolved with the architect) and 2026-07-31 (two-session
consolidation, grill — 9 forks, `grill-summary.md`): PR as the default gate with interrupt
break-through, harness-owned roster carrying phases/model/effort. A build session can start from this spec.
First build slice suggestion: the local Node/TS server + SQLite registry + Projects-Grid home reading
live git/tracker/session state (§2, §4, §6 home) — then the per-project Team room + SDK session driving
(§3, §6 detail).
