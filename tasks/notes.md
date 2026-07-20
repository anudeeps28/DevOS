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

---

## Blockers

<!-- Things waiting on external action — APIs, people, services. -->
<!-- | What | Waiting on | Since | -->
<!-- | API v2 access | Third-party approval | 2026-04-05 | -->
