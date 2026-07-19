# Notes

Running log of decisions, conventions, known fixes, and things to remember. Claude reads this at the start of every session.

---

## Code Conventions

> Define your project's coding style here. Agents read this section to follow your patterns.
> Below is an example — replace with your own conventions.

**Language:** [your language — e.g. TypeScript, Python, Go, C#]

**Build command:** [e.g. `npm run build`, `go build ./...`, `dotnet build`]
**Test command:** [e.g. `npm test`, `pytest`, `go test ./...`]
**Lint command:** [e.g. `npm run lint`, `ruff check`, `golangci-lint run`]

**Naming:**
- [e.g. camelCase for functions, PascalCase for types]
- [e.g. test files: `*.test.ts` or `*_test.go`]

**Patterns:**
- [e.g. use async/await, not callbacks]
- [e.g. error handling: return errors, don't throw]

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
- Build: `<!-- your build command (e.g., npm run build, go build ./..., dotnet build) -->`
- Unit tests: `<!-- your unit test command (e.g., npm test, pytest tests/unit/, go test ./... -short) -->`

**Level 2 — Integration Tests (may require Docker/emulators):**
- Setup: `<!-- command to start dependencies (e.g., docker compose up -d, or "not applicable") -->`
- Integration tests: `<!-- your integration test command (e.g., npm run test:integration, pytest tests/integration/) -->`
- Cleanup: `<!-- command to stop dependencies (e.g., docker compose down) -->`

**Level 3 — Dev Server (for manual testing):**
- Dev server: `<!-- command to start the app (e.g., npm run dev, go run ./cmd/server/, uvicorn main:app --reload) -->`
- Dev server URL: `<!-- e.g., http://localhost:3000 -->`

**Test filtering (for verify commands):**
- Run a specific test class: `<!-- e.g., npm test -- --grep "ClassName", pytest tests/test_file.py -->`
- Run a specific test: `<!-- e.g., npm test -- --testNamePattern "test name", pytest tests/test_file.py::test_name -->`

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
