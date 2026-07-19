# Development OS — per-project workspace reference design (notes)

**Source:** an external reference mockup — a full clickable HTML prototype, kept locally (drop the
raw HTML into the Dev OS repo's `design/` folder if you want it committed). This file distills what the
mockup decides so the spec (wayfinder ticket H) can build on it. Local scratch — moves to the Dev
OS repo with the rest of the Dev OS planning artifacts.

> Note the mockup is styled for an Azure DevOps / enterprise team ("Contoso / Payments", team of
> named agents, karma, org skills). Treat the *interaction model* as the reference; the multi-user
> / enterprise framing is a later concern, not V1 (V1 is local, single-user).

---

## What the reference design settles for ticket F (planning & discussion experience)

**Discuss surface = a per-work-item "Team room".** A live transcript bound to that item's local
Claude Code session. The human steers by messaging the team ("steer, correct, add context"); replies
fold into the next loop. It is a live session in *normal* mode driven by the harness's phase skills —
NOT Claude Code plan-mode.

**The pipeline is the harness's own phases, surfaced as UI:**
`Analyze → Plan → Code → Test → Fix → Review → PR` (maps to README's Decide → Define → Build →
Evaluate → PR). A per-item timeline shows the current stage and loop number.

**A lead agent orchestrates named specialist sub-agents** within the phases — architect, developer,
QA, security, devops. One lead agent, many specialists. One work item = a team fanning out.

**Handoff = human review gates between phases:**
- **Plan gate** — after Plan: shows decomposition, files in scope, test strategy → "Approve plan ·
  start coding" or "Request changes" (with notes).
- **Review gate** — after Review: code + tests + security done → "Approve & open PR" or "Request
  changes".
- **Kick off** = *Assign work* (item pulled live from the tracker) → the team runs the loop and
  reports at each gate. Nothing advances without an explicit human "go" (the harness's supervised model).

**Inline interrupts** surface in the transcript as cards, each pausing the session until answered:
- **Question** — agent asks the human a decision (with quick-reply chips + free text).
- **Permission** — `canUseTool` grant/deny (research A) for a sensitive action.
- **Escalation** — loop cap reached → "let debug agent try / give guidance / take over".

**Skills** are surfaced in a Skills panel: **org skills** (read-only, versioned, synced) + **local
skills** (editable, can *override* an org skill). Invoked as the pipeline runs; edits to org skills
are proposed as PRs to the shared skills repo. Answers the "how do per-project skills surface" fog item.

---

## Broader IA the mockup demonstrates (feeds ticket H + fog items)

- **Left activity rail → sidebar panels:** Needs-you (inbox) · Explorer (project → feature → story
  tree) · Your team (agent swarm) · Skills. Plus Settings/Profile.
- **Editor-tab shell** (VS Code-like): open dashboard / board / work items / skills as tabs.
- **Views:** Dashboard (awaiting-you hero + in-progress + live activity feed), Board (kanban across
  the pipeline columns Queued→Planning→Coding→Testing→Review→PR→Merged), Work-item Detail (pipeline
  timeline + Team room + gates + files/tests/PR-summary + artifact audit trail), Agents, Skill editor,
  Lessons, Settings, Profile.
- **Unified "Needs you" inbox** — every blocked item across the pipeline, sorted by wait time
  (Omnara pattern from research B). Resolves the **notifications** fog item (OS toast + inbox + status bar).
- **Cost/usage** — per-item token $ and a cost-today status-bar figure. Resolves the **cost visibility** fog item.
- **Model management** — abstract role slots (Deep Thinking / Fast Coding / Cheap Reads) each a
  priority chain across providers with automatic failover. (New — not previously in the map.)
- **Learning loop** — per-run **Retro** proposes skill/agent improvements (low-risk auto-PR'd,
  high-risk human-gated) → a **Lessons** feed. Mirrors the harness's continuous-learning / calibrate.
- **Audit trail** — every process doc (brief/plan/test-strategy/evaluation/security-review) tracked
  Draft→Final per item. (Enterprise/trust framing; V1-optional.)
- **Karma** — stewardship gamification for the human (reviewing gates, answering, improving skills —
  never throughput). Clearly a later/optional layer.

---

## To reconcile with earlier decisions

- **Ticket D (home IA = Projects Grid).** The reference design renders a *single* project workspace (Contoso /
  Payments) in an IDE-like shell — it is the **per-project drill-down**, one level below the
  multi-project Projects-Grid home from D. They are different zoom levels, not a conflict: Projects
  Grid = "all my projects" home → open one → this workspace. The spec should state that layering
  explicitly. (If YOUR_NAME instead wants the single-project IDE shell to *be* home, that reopens D.)
- **Scope guard for V1:** the enterprise/team framing (named teammates, karma, org-vs-local skills,
  Azure Boards, document audit trail) is richer than the map's V1 ("local, single-user, full control").
  Keep the **interaction model** (Team room, phase pipeline, gates, inbox, skills panel, cost) for V1;
  defer multi-user/enterprise/karma to later.
