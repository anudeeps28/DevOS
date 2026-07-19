# Prototype: Development OS — home screen information architecture

**Chosen:** Candidate A — Projects Grid (as home). B (Fleet) and C (Inbox) retained as adopted peer rail tabs — not deleted, since the decision keeps them as first-class screens.

**Date:** 2026-07-18
**Wayfinder ticket:** #5 Main screen look & IA (`6h6M5frRRgrPWg88`, type `prototype`)
**Question:** What should the home screen's *primary organizing axis* be — projects, agent sessions, or tasks? The choice decides what you see first and what everything else nests under.
**Candidates:** 3 (open each `index.html` in a browser)

- **A — Projects Grid** (`candidate-a/`): the project is the atom; agents + next-task are compressed onto each card.
- **B — Agent Fleet View** (`candidate-b/`): the live session is the atom, sorted into Needs-you / Running / Idle lanes.
- **C — Unified Tracker Inbox** (`candidate-c/`): the task is the atom, pulled from every project's own tracker adapter.

All three share one left rail (Projects · Agents · Inbox · History · Settings), so the real question is only *which is home* — the other two always exist as peer tabs.

## Comparison

| Dimension | A — Projects Grid | B — Agent Fleet | C — Tracker Inbox |
|---|---|---|---|
| Primary atom | Project | Live session | Task |
| Mental model it reinforces | "my repos" (durable) | "what my agents are doing now" (volatile) | "what to work on next" (planning) |
| Answers *"what needs me right now?"* | OK — badge + KPI, but one card among many | **Best** — dedicated top lane, impossible to miss | Weak — buried as a per-task state |
| Answers *"what do I start next?"* | OK — one next-task per card | Weak — only shows already-running work | **Best** — every open task, priority-ranked, spawn inline |
| Calm / populated when few agents run | **Best** — always full, agents optional | Poor — near-empty ops board when idle | **Best** — tasks always exist |
| Scales as agent count grows | Cards get noisy (many rows/card) | **Best** — lanes absorb volume | OK — doing-tags on rows |
| Leans on our differentiator (tracker adapters) | Partial (next-task chip) | No | **Best** — the whole screen *is* the adapter layer |
| Embeds the other two axes | **Yes** — mini-fleet + next-task per card | No (projects = filter only) | Partial (agent state as attribute) |
| Build complexity | Low | Medium | Medium |

## Recommendation

**Winner: Candidate A — Projects Grid**, as the default home; **B and C promoted to first-class peer tabs** (already in the rail).

Rationale, tied to the question: for a **solo dev with a handful of projects**, the *project* is the only axis that is always populated and always meaningful — agents and tasks ebb and flow, projects persist. A is also the only candidate that **embeds the other two** (each card carries a compressed fleet strip and the next task), so home stays a true "see everything" surface without committing the whole screen to one loop. The one thing A does less loudly — "agent X is blocked" — is cheaply fixed: the KPI strip calls it out, the card self-highlights, and a notification deep-links straight into the Fleet tab (B). That keeps home calm by default and loud on demand.

**Runner-up: Candidate B — Agent Fleet View.** Pick this as home instead if your real daily reality is **many concurrent agents** — once 5+ sessions run at once, the unblock/steer loop dominates every session and the fleet lanes become the screen you stare at. A then demotes to a secondary "overview" tab. This is the fork worth deciding honestly: **home = Projects if project-count is your scale; home = Fleet if agent-count is your scale.**

Candidate C — Tracker Inbox is the weakest as *home* (it hides live presence) but is the strongest **"plan & kick off work"** tab and the clearest showcase of the tracker-adapter differentiator. It should ship as the Inbox tab regardless of which wins home.

## How to promote the winner

This is a wayfinder **planning** decision, not a build. Promoting = recording the resolution, not writing app code:

1. Comment the resolution on ticket #5 and close it; gist onto the map `6h6M5cm9WjffWxfg`.
2. Feed the decision into ticket #9 "Assemble the buildable spec": home screen = chosen axis; other two axes are peer rail tabs; the notification→deep-link behavior is a spec requirement (ties into the "notifications" fog item still in *Not yet specified*).
3. Keep the winning `index.html` as the visual reference attached to the spec; the real UI gets built later (out of scope for this map).
