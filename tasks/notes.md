# Notes

Running log of decisions, conventions, known fixes, and things to remember. Claude reads this at the start of every session.

---

## Code Conventions

**Language:** TypeScript (Node LTS >= 20). Monorepo via **npm workspaces** — `server/` (Node/`ws`, built with `tsc`, run with `tsx` in dev) and `web/` (React + Vite + Tailwind v3 + shadcn/ui).

**Build command:** `npm run build`  (→ `web/dist` via Vite, then `server/dist` via `tsc`)
**Test command:** `npm test`  (Vitest, unit + integration)
**Lint command:** `npm run lint`  (ESLint 9 flat config — `eslint.config.js`)

**Naming:**
- camelCase for functions/variables, PascalCase for types/React components
- test files: `*.test.ts` / `*.test.tsx` co-located next to source; integration tests under `server/test/integration/`; e2e specs under `e2e/`

**Patterns:**
- Immutable: return new objects, never mutate (heartbeat frames + WS client state are fresh each tick — see global coding rules)
- async/await, not callbacks
- Validate at boundaries (WS payloads parsed + shape-checked on the client; malformed frames dropped + logged, never thrown into the app)
- Small focused files (200–400 lines); comprehensive error handling (fail fast with clear messages, e.g. `EADDRINUSE`)
- TS is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (base config in `tsconfig.base.json`, both workspaces extend it)

---

## PRD Configuration

Where PRDs are stored. The `/prd` skill reads this at start to determine output mode.

```
prd_mode = file
```

Options:
- `file` — write `PRD.md` to the repo (default)
- `tracker` — publish as a tracker issue only
- `both-file-canonical` — file + tracker; file is canonical
- `both-tracker-canonical` — file + tracker; tracker is canonical

---

## Git Rules

- **Branch naming:** `implement/<issue-id>-<short-description>` (e.g. `implement/42-dark-mode`)
- **Commit format:** `#<issue-id> <description>` (e.g. `#42 Add dark mode toggle to settings`)
- **Never** commit directly to main — always use a branch + PR

---

## Test Commands

> Skills and agents read this section to run the correct test commands for your stack.
> Fill in every command that applies to your project. Leave others as `<!-- not applicable -->`.

**Level 1 — Build + Unit Tests (no external dependencies):**
- Build: `npm run build`  (also: `npm run typecheck` for `tsc -b` across both workspaces)
- Unit tests: `npm test`  (Vitest run — `server` node project + `web` jsdom project)

**Level 2 — Integration Tests (may require Docker/emulators):**
- Setup: not applicable — integration tests boot the real server in-process (no Docker/emulators)
- Integration tests: `npx vitest run server/test/integration`
- Cleanup: not applicable (in-process; server torn down in `afterAll`)

**Level 3 — Dev Server (for manual testing):**
- Dev server: `npm run dev`  (Vite + `tsx watch` for the server, run concurrently)
- Dev server URL: `http://127.0.0.1:5173`  (Vite; proxies `/ws` → Node server on `127.0.0.1:8787`)
- Prod (single process): `npm run build && npm start` → `http://127.0.0.1:8787`  (serves `web/dist` + WS on the same origin)
- e2e: `npx playwright test`  (drives the prod app; specs control their own server child process)

**Test filtering (for verify commands):**
- Run a specific file: `npx vitest run <path>`  (e.g. `npx vitest run server/src/heartbeat.test.ts`)
- Run a specific test: `npx vitest run <path> -t "<name>"`
- e2e: `npx playwright test`  (single spec: `npx playwright test e2e/heartbeat.spec.ts`)

---

## Worktree setup

- **Files to copy into a new worktree:** none yet — no gitignored config files are required to build (no `.env`/secrets in V1).
- **Restore command (run after creating a worktree):** `npm install`  (npm workspaces — one install resolves both `server/` and `web/`; this also rebuilds the `better-sqlite3` native addon in the fresh worktree).
- **Shared automatically (do NOT copy):** `tasks/`, the `.git` history.
- **SQLite DB — nothing to copy:** the thin-anchor store is generated at runtime in the default OS app-data dir (e.g. `~/Library/Application Support/DevOS/devos.db` on macOS; override with the `DEVOS_DB_PATH` env var) and is gitignored (`*.db` / `*.db-wal` / `*.db-shm`), so there is no DB file to carry into a new worktree.

---

## Known Fixes

<!-- Add entries when you discover something non-obvious that fixes a recurring problem. -->
<!-- | Date | Problem | Fix | -->
<!-- | 2026-04-10 | Docker build fails on M1 | Add `--platform linux/amd64` to docker build | -->

| Date | Problem | Fix |
| 2026-07-26 | An integration test that serves/reads a **build artifact** (`web/dist/index.html`) passed locally but 404'd in CI. CI runs `npm ci → lint → typecheck → test` with **no `npm run build`**, so `web/dist` doesn't exist on the runner; locally it lingered from a prior build → false green. | Make such tests **self-provision** the artifact: write a minimal fixture when the build output is absent and remove only what the test created (use the real build output as-is when present). Verify the CI condition locally by moving `web/dist` aside before running. Sibling of the PR #7 lesson ("run typecheck in the local gate, not just build+test"). |

---

## Decisions

<!-- Record why you chose approach A over approach B — future-you will thank present-you. -->
<!-- | Date | Decision | Why | -->
<!-- | 2026-04-08 | Use SQLite instead of Postgres for dev | Simpler local setup, no Docker needed | -->

| Date | Decision | Why |
| 2026-07-18 | V1 stack: Node/TS server, Agent SDK in-process (primary) + `claude -p` (fallback), React+Vite+Tailwind+shadcn/ui, WebSocket, SQLite via better-sqlite3 (raw, no ORM) | Locked in wayfinder ticket G; better-sqlite3 raw chosen — thin-anchor store is ~4 tiny tables, ORM is overkill |
| 2026-07-18 | PTY/tmux terminal-attach → deferred to post-V1 | Owned sessions run headless (no terminal exists); the UI transcript is the sole view. PTY only mirrors hand-opened foreign terminals — a side-case, not the main workflow (assign→watch→steer→gates→PR, all in-UI) |
| 2026-07-18 | **[VERIFIED]** Programmatic sessions authenticate via the Claude **subscription** (OAuth), NOT the pay-per-token API | Probed on this Mac with `ANTHROPIC_API_KEY` empty: both Agent SDK `query()` and `claude -p` ran successfully — both inherit the CLI's keychain OAuth login. Operating cost ≈ $0 metered; the real cap is plan **rate limits**, not budget. `total_cost_usd` from the stream is a usage indicator, not a bill. Multi-provider model routing (implies API keys) stays post-V1 per SPEC §9. Boundary: a headless host without the keychain login would need an API key (not a V1 scenario) |
| 2026-07-19 | Scaffold foundation: monorepo = **npm workspaces** (`server/` + `web/`); WS lib = **`ws`**; server binds **`127.0.0.1:8787`**; test tooling = **Vitest** (unit + integration) + **Playwright** (e2e). Origin-check / local WS token **deferred** to the M1 localhost-security task | server and web have genuinely different toolchains (Vite/React vs `tsc`/`tsx`) → workspaces give one install/lockfile with isolated configs. `ws` is lightweight and exposes the raw HTTP `upgrade` event the deferred security task needs. Loopback-only bind is the core V1 security boundary (ARCHITECTURE §6) |
| 2026-07-19 | Project-lifecycle level (map `6h6gPPWFfHr5PwG8`, T1–T3) folded into docs — IN V1 | **T1** stage model = harness's New→Decide→Define→Build→Ship(→Learn); sticky high-water badge, `max(precedence)` detection, live-derived. **T2** "Kick off next stage" = launcher only (emergent advance), light gating, project-bound Team room (one component, two bindings). **T3** birth = shell out to harness installer ("New Idea"/"Add Project"), land at New, auto-launch `/wayfinder`. Compiled into ARCHITECTURE.md §9 + SPEC §4/§6/§9. Deferred fog: new-milestone reset, reliable Learn detection |

---

## In Progress

- ✅ [DEFINE] /architect — Development OS (V1) — 8 sections complete — output: docs/ARCHITECTURE.md
- ✅ [DECIDE] /grill-me — Lifecycle stage model & detection (wayfinder ticket 6h6gPRW84r82PG58) — 5 forks resolved, output: grill-summary.md
- ✅ [DECIDE] /grill-me — Kick off next stage — project-level advance (wayfinder ticket 6h6gPRg5GrgjqCQ8) — 6 forks resolved, output: resolution recorded on the ticket + map gist (map 6h6gPPWFfHr5PwG8)
- ✅ [DECIDE] /grill-me — New idea / project birth flow (wayfinder ticket 6h6gPRxpmhxGvqv8) — 5 forks resolved, output: resolution recorded on the ticket + map gist (map 6h6gPPWFfHr5PwG8)
- ✅ [DEFINE] compile — project-lifecycle map (6h6gPPWFfHr5PwG8) T1–T3 folded into docs/ARCHITECTURE.md §9 + docs/SPEC.md §4/§6/§9 (map destination reached)
- ✅ [DEFINE] /to-todoist — SPEC decomposed into build tasks: 4 milestones + 28 subtasks in Todoist "Build Mode" / section "DevOS Build" (M1 foundation → M2 session driving → M3 pipeline+gates → M4 lifecycle actions). First task: "Scaffold server + web shell + WebSocket" (M1, p1)
- ✅ [BUILD] /implement — SQLite thin-anchor store + Project Registry (M1, Todoist 6h6hMMG3PQh9vwM8) — merged PR #2. better-sqlite3 (raw) 4-table store; Registry persists only {path,pinned,displayName,uiPrefs}; pin/unpin over WS; 75 unit/integration + 3 e2e green. Deviation: better-sqlite3 pinned to 12.x (11.x has no Node-26 prebuild). Deferred: WS origin/token gate → M1 localhost-security task (first client-writable surface now exists)
- ✅ [BUILD] /implement — Project discovery + pin UI (M1, Todoist 6h6hMMP4J4XW6cWg) — merged PR #3. Depth-1 `.claude/` scanner over env `DEVOS_PROJECT_ROOTS` (default `~/Programming`); new WS `discover`→`candidates` frame pair (candidates are a live scan, NEVER persisted — thin-anchor held); ProjectPin upgraded → Discovered list + Pinned grid + empty state. 108 vitest + 4 e2e green; acceptance ACCEPTED; architect CLEAR; evaluator CLEAR. Hardening added in-PR: per-socket `discover` debounce + scanner entry-scan cap. **Deferred:** (1) WS origin/token gate — discovery escalated its impact (now leaks FS paths cross-origin, CSWSH); tracked as a comment on the "Projects Grid + localhost security" task (6h6hMMj3PX4Gjcr8), treat as BLOCK before end-user exposure. (2) Minor/skipped advisories NOT worth a task: client-side handling of the `registry:error` frame is still unmirrored in ws-client.ts (pre-existing since PR #2 — failed pin/unpin isn't surfaced to the user); redundant `entry.isSymbolicLink()` guard in scanner.ts (harmless).

- ✅ [BUILD] /implement — Git State Reader (M1, Todoist 6h6hMMRWgccMjjx8) — merged PR #7. Fourth live-derive reader: server `readGitState()` via `execFile` (single `git status --porcelain=v2 --branch`, zero-dep, offline, no fetch, 5s timeout) → frozen GitState, never cached; new per-path `git-state` WS frame pair (mirrors discover→candidates); web mirror + git-status line on pinned rows. **Fixed in-review:** flood-guard re-keyed per-path (was a per-socket scalar that dropped the fan-out); `useHeartbeat.test.ts` mock gap surfaced the **lesson: run typecheck in the local gate, not just build+test.** Hardened git invocation vs malicious repo-local `core.fsmonitor`/`core.hooksPath`. **Deferred:** path confinement → Origin/token task (6h6hMMj3PX4Gjcr8).
- ✅ [BUILD] /implement — Story + Project Lifecycle Readers (M1, Todoist 6h6hMMcgMvVRr6Mg) — merged PR #9. Sixth live-derive reader + client-composed lifecycle stage badge (New→Decide→Define→Build→Ship). Server `readLifecycleSignals` emits only the signals the client can't derive (local docs, started-story, feature-branch-with-commits, release-tag) over a new `lifecycle-signals` WS frame; the **stage is composed CLIENT-side** (`web/src/lib/lifecycle.ts` `resolveStage`, max(precedence)) reusing the card's already-fetched tracker-state — so the server no longer shells the tracker or runs `git status` for the lifecycle. `readStoryStates` flags a genuinely started story (executor-state.md + Progress section). Render-only `StageBadge` (data-stage) on each card. 230 vitest (24 files) + build + typecheck + lint green; acceptance ACCEPTED; AC-sanity: DevOS repo → Build (live). **Fixed in-review (4 agents):** (A) wayfinder:map mis-derived as Define — now Decide-only, never both; (B) **pinned-path access-control allowlist** (`isPinnedPath`) added to ALL THREE read frames (git-state/tracker-state/lifecycle-signals), fails closed — closes the arbitrary-path FS/git oracle; (C) Ship tightened to a release-tag regex, Build to a non-default branch with ≥1 commit; (D) read-duplication removed by moving stage derivation client-side. `createServer` now exposes `registry` as a test seam. **Deferred → 6h6hMMj3PX4Gjcr8:** WS Origin/token connection gate; unbounded flood-guard Maps + global bash-spawn cap; fully de-duplicating server-side git reads (needs a GitState contract extension for tags/commits).
- ✅ [BUILD] /implement — Projects Grid + localhost security (M1, Todoist 6h6hMMj3PX4Gjcr8) — merged PR #10. **The security task the readers all deferred.** WS connection gate closes the accumulated CSWSH / localhost-DNS-rebinding surface: `verifyClient` at the upgrade — Origin allowlist (present foreign origins rejected in BOTH dev+prod; origin-absent rejected in prod) + **prod-only local token** on the `Sec-WebSocket-Protocol` subprotocol (`['devos','token.<hex>']`, never a query param). Token minted per process (`randomBytes(32)`, in-memory, never persisted), delivered via `<meta name="devos-ws-token">` injected into prod `index.html`, `timingSafeEqual` compare, charset-validated (fails fast on non-hex). **HTTP-side twin:** `handleProd` rejects non-loopback `Host` (403) before serving the token-bearing index — closes the DNS-rebinding exfil. DoS hardening: bounded flood-guard Maps (evict at 256) + global bash-spawn semaphore (max 4, waiter queue capped 64). Projects Grid: each pinned project → a **card** (static mini-fleet placeholder + next-task strip + stage badge). 274 vitest (29 files) + 5 e2e green. **4 review agents:** acceptance ACCEPTED, architect CLEAR, evaluator CLEAR, security **BLOCK (1) + 3 ADVISORY — all fixed in-PR** (Host-header gate; dev-origins gated behind `!requireToken`; token charset validation; bounded spawn queue; silent-no-token warn). **CI hotfix:** `http-host.test.ts` served a build artifact CI never builds → self-provisions a fixture (see Known Fixes 2026-07-26). **Dev/prod split:** Origin enforced both modes; token prod-only (Node can't hand a token to the Vite dev page). **Deferred (non-blocking):** ARCHITECTURE.md §6/§5 doc update for token-delivery mechanism + spawn caps → follow-up doc pass; flood-guard eviction weakening under ≥256 active paths (bounded/safe, coverage test added).
- ✅ [BUILD] /implement — Tracker Adapter Gateway (read) (M1, Todoist 6h6hMMX6v4Jrm858) — merged PR #8. Fifth live-derive reader + next-task strip per card. Server `readTrackerState()` shells out to **each project's own** `.claude/trackers/active/get-sprint-issues.sh` (cwd=project root) via `execFile('bash',…)` — 5s timeout, 1 MiB cap, drop-don't-throw, frozen `TrackerState`, never cached; **quarantined** normalizer (`server/src/tracker/normalize.ts` — the ONE module with tracker logic; Todoist-only for V1, replaceable seam for a future normalized adapter op). New per-path `tracker-state` WS frame pair + per-path flood-guard (mirrors git-state); web mirror + `NextTaskLine` (task title / "no open tasks" / "no tracker" / "tracker unreachable"). 182 vitest (20 unit normalizer+reader, 3 WS integration incl. AC1/AC2 + single-socket fan-out) + build + typecheck green; acceptance ACCEPTED; architect CLEAR; security CLEAR (injection-safe — argv-form execFile, no shell); evaluator CLEAR. **Fixed in-review:** (A) normalizer rejects tasks missing id/content instead of coercing to `{id:"undefined"}`; (B) hand only an **allowlisted env** to the untrusted repo-local adapter (not full `process.env`) — verified live: real `td` still authenticates under the scrubbed env; (C) null-tracker renders distinct "no tracker" vs empty backlog. **Deferred → comment on 6h6hMMj3PX4Gjcr8:** unbounded per-socket flood-guard Maps + no global bash-spawn cap (memory-DoS); origin/token gate absence — tracker-state escalates its impact from "read git status" to "run a shell script" (BLOCK before non-trusted exposure).
- ✅ [BUILD] /implement — Session Manager (Agent SDK) (M2 — FIRST task, Todoist 6h6hMV2xg8MgXCG8) — merged PR #12. **M2 core: spawn + multiplex owned Agent-SDK sessions in the one process.** `session-engine.ts` isolates the `@anthropic-ai/claude-agent-sdk` (`query()` streaming) import behind an injectable `QueryFn`/`EngineSession` seam (real SDK default, deterministic fake in ALL CI tests — no live Claude in CI). `session-manager.ts`: live-session Map, detached stream-consume loop (running→ended/errored, `sdk_session_id` captured from `system/init`), per-session failure isolation, `stopAll` awaits consume loops on shutdown. `session-spawn-limit.ts` global semaphore (`MAX_CONCURRENT_SESSIONS=8`, queue 64, acquire→release). `session-store.ts` sole reader/writer of the `sessions` table + additive idempotent `role`-column migration (`ensureColumn` via `PRAGMA table_info`). New `session-spawn`→`session-state` WS frames; thin web mirror (spawn button + running-count, NO transcript). 307 vitest (1 skipped opt-in live probe) + 5 e2e green; acceptance ACCEPTED; architect CLEAR; evaluator CLEAR. **AC5 (real-SDK spawn under subscription auth, no API key) self-run PASS** via env-gated `DEVOS_LIVE_SDK=1` probe. **Security BLOCK ×2 fixed + re-validated in-PR:** (A) spawn cwd two-layer gate — pinned AND realpath-contained within a `PROJECT_ROOT` (`isWithinProjectRoots`, fails closed); pinning alone doesn't bound the subprocess cwd; (B) scrubbed subprocess env (allowlist mirroring `tracker-reader.buildAdapterEnv`, excludes `ANTHROPIC_API_KEY`/secrets) — live probe confirms subscription OAuth still works; (C) `workItemId` length bound; (D) acquire slot BEFORE DB insert (no unbounded row growth under flood). **Deferred (own downstream tasks):** Team room transcript, Steer+interrupt, Permission cards (`canUseTool`), Hook Event Bus, the Bridge orchestrator, per-socket spawn quota, "waiting — plan limit" first-class queued state, client-facing `session-error` frame, persisted-status crash-staleness reconcile, pin-time PROJECT_ROOTS containment.
- ✅ [BUILD] /implement (--autonomous) — Steer + interrupt (M2, Todoist 6h6hMV8QfFvwCMP8) — branch implement/steer-interrupt. **Two-way live session control.** `session-engine.ts` `kickoffInput` → queue-backed **`createInputStream`** (kickoff-first, stays-open, close-drains; bounded at `MAX_PENDING_INPUTS=256`); `EngineSession` seam gains `send(text)` alongside `interrupt()` (SDK-import stays sole to this file). `SessionManager.sendInput` (echoes a new **`user-text`** transcript event — the SDK doesn't echo streaming-input — then pushes to the engine, per-session isolated) + `interrupt(id)` (turn-abort only; session stays `running`). New inbound WS frames **`session-input`** (bounded `MAX_STEER_TEXT_LENGTH=8192`, rejected-not-truncated) + **`session-interrupt`**, routed fail-closed in `ws-gateway.ts` via `get(sessionId)→isPinnedPath` (mirrors `session-transcript-request`; no broadcast, no flood-guard — deliberate user action). Web: `ws-client` senders + `user-text` mirror; TeamRoom message input + Interrupt button + `user-text` row, threaded App→useProjects. 434 vitest (2 opt-in live probes skipped) + build + typecheck + lint green. **4 review agents:** acceptance ACCEPTED, evaluator/architect/security all CLEAR (0 BLOCK). **Fixed in-review:** bounded the `createInputStream` steer queue (security ADVISORY #1). **Deferred (ADVISORY, non-blocking):** no-op logs at error level (matches existing convention); transcript echo truncated to `MAX_TEXT_CHARS=4000` while full ≤8192 text reaches the engine (deliberate, consistent with assistant-text truncation). **Enables:** Permission cards (`canUseTool`) + `setPermissionMode` ride this same up-channel next.
- ✅ [BUILD] /implement (--autonomous) — Bridge orchestrator + role roster reader (M2/M3, Todoist 6h76V8J6cJxXJQV8) — merged PR #15. **The deterministic pipeline orchestrator (server code, NOT an agent — zero prompting/role logic).** `roster-reader.ts` reads+validates each project's `.claude/harness-roles.json` (drop-don't-throw → frozen typed `Roster`). `bridge.ts` walks the roster pipeline (navigator→shipwright→lookout→warden→harbormaster) via the existing `SessionManager`: gated-advance by default (pause at each gate), auto-advance when `ui_prefs.auto_advance` ON + clean end, generic `interrupt(path,{kind,reason})`→Needs-you-inbox breakthrough (pauses regardless of toggle), rework routing (respawn shipwright with an injected failure-report as `SpawnInput.prompt`) with a `reworkLoopCap`→escalate. **Thin-anchor HELD:** pipeline position is an in-memory `Map` only, never persisted; only `sessions.current_stage` (new `SpawnInput.currentStage` writer) + read-only `ui_prefs.auto_advance` touch storage. New `bridge-start`/`gate-approve`/`bridge-interrupt` inbound + `bridge-state` outbound WS frames; gateway routes them with `isPinnedPath`+`isWithinProjectRoots` fail-closed (mirrors `session-spawn`); `bridge-state` broadcast `isPinnedPath`-gated. Thin web mirror + `NeedsYouInbox` component. 397 vitest (1 skipped opt-in live probe) + build+typecheck+lint green. **4 review agents:** acceptance ACCEPTED, evaluator/architect/security all CLEAR (0 BLOCK). **Fixed in-review:** missing `run.paused` guard on the errored path (an interrupt must pause `errored` too, not just `ended` — AC3 hole) + regression test. **CI hotfix:** integration test hardcoded an absolute dev path to `.claude/harness-roles.json` → ENOENT on the runner; now self-provisions a minimal inline roster fixture (sibling of the 2026-07-26 self-provision lesson). **Scope split:** Permission/`agent_needs_input` interrupt sources DEFERRED to the tracked canUseTool + Hook Event Bus tasks (the generic breakthrough entry is built so they plug in with no rework). **Deferred (own follow-ups):** rework return-path semantics (stale `run.index` post-rework is an open pipeline-design decision AC4 left unspecified); hardening advisories — roster-read byte-cap, unbounded inbox cap, spawn-containment defense-in-depth/TOCTOU, rework-prompt provenance.

---

## Blockers

<!-- Things waiting on external action — APIs, people, services. -->
<!-- | What | Waiting on | Since | -->
<!-- | API v2 access | Third-party approval | 2026-04-05 | -->
