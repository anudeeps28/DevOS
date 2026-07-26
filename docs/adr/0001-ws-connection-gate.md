# ADR 0001 — WebSocket connection gate: Origin allowlist + subprotocol-carried local token

- **Status:** Accepted
- **Date:** 2026-07-26
- **Realized in:** PR #10 (Todoist 6h6hMMj3PX4Gjcr8 — "Projects Grid + localhost security")
- **Relates to:** ARCHITECTURE.md §6 (Security architecture), §5 (Scalability model)

## Context

DevOS binds to `127.0.0.1` and exposes a WebSocket that drives capability-bearing read handlers —
`discover` (enumerates `.claude/` projects under `DEVOS_PROJECT_ROOTS`, leaking filesystem paths),
`git-state`, `tracker-state` (shell-executes each project's `.claude/trackers/active/get-sprint-issues.sh`),
and `lifecycle-signals`. Loopback binding stops the LAN, but **not another web page in the user's own
browser**: any page could `new WebSocket('ws://127.0.0.1:8787/ws')` and drive those handlers — classic
**Cross-Site WebSocket Hijacking (CSWSH)**, and a **localhost DNS-rebinding** target.

Each reader PR (#2/#3/#7/#8/#9) escalated the impact and deferred the connection gate to this task.
The per-request `isPinnedPath` allowlist (PR #9) narrowed the *path* surface but does nothing to stop a
foreign origin from *connecting*. ARCHITECTURE.md §6 mandates the control — "Origin check + local token,
only the app's own page may open the WebSocket" — but left the delivery mechanism and dev/prod behavior
unspecified. This ADR records how it was realized and why.

### Constraint that shaped the design

In **dev**, the Vite dev-server (`:5173`) serves the HTML and proxies `/ws` to the Node server (`:8787`);
Node never serves the dev page, so it **cannot hand a token to it**. In **prod**, the page and the WS share
one origin on the Node server, which *can* inject a token into the HTML it serves.

## Decision

A connection gate at the WS **upgrade handshake** (`verifyClient`), gating the connection — not per-message
(per-message path-ownership via `isPinnedPath` remains a separate defense-in-depth layer).

1. **Origin allowlist — enforced in BOTH dev and prod.** A *present* foreign `Origin` is always rejected.
   An *absent* Origin (non-browser clients) is rejected in prod, allowed in dev/test. A browser always sends
   `Origin` honestly, so this alone blocks the CSWSH / rebinding threat in both modes.
2. **Local token — prod-only second factor.** A per-process token (`crypto.randomBytes(32)` hex, in memory,
   never persisted) required only in prod (`requireToken` defaults to `PROD`, overridable via
   `createServer({ requireToken })` so tests can force-enable it). Compared with `crypto.timingSafeEqual`
   after a length check; a non-hex explicit/env token fails fast at startup.
3. **Delivery = `<meta name="devos-ws-token">` injected into the served prod `index.html`.** The client reads
   it and presents it on dial via the **`Sec-WebSocket-Protocol` subprotocol** (`['devos', 'token.<hex>']`),
   never a query string (avoids logging the token). The server echoes only the fixed `devos` subprotocol via
   `handleProtocols`.
4. **HTTP-side twin.** The prod static handler **rejects non-loopback `Host` headers (403)** before serving
   the token-bearing `index.html`, closing the rebinding path where a rebound page could `fetch('/')` and read
   the token. Both the WS Origin gate and the HTTP Host gate fail closed.
5. **DoS hardening (co-landed).** Per-socket flood-guard Maps bounded at `FLOOD_GUARD_MAX_KEYS = 256`; a global
   `MAX_CONCURRENT_TRACKER_SPAWNS = 4` bash-spawn semaphore with a `MAX_SPAWN_QUEUE = 64` waiter cap.

## Consequences

**Positive.** Closes the CSWSH / DNS-rebinding surface (the browser threat is covered in both modes by Origin
alone; the token is belt-and-suspenders in prod). No stored secret (§6 "stores no secrets" holds). Existing
Node-`ws` integration tests pass unmodified (they send no Origin and run non-prod). Token never logged
(subprotocol transport + value-free rejection logs).

**Negative / residual.**
- **Dev is Origin-only** — a malicious *native* process on the loopback (which can forge any Origin) is not
  stopped in dev. Bounded by the 127.0.0.1 bind and single-user local threat model; the token closes it in prod.
- **e2e harness must pin a stable `DEVOS_WS_TOKEN`** across server respawns, or a reloaded page's token would
  go stale on reconnect.
- **Flood-guard eviction weakens the throttle** under ≥256 *active* pinned paths (evicts non-expired entries to
  stay bounded). Safe (memory stays capped) but the throttle is best-effort at extreme scale.

## Alternatives considered

- **Token via query string** — simpler, but the token would land in logs/URLs. Rejected.
- **HttpOnly `SameSite=Strict` cookie** — elegant (auto-sent, JS can't read it), but Node doesn't serve the dev
  page so the cookie isn't set in dev either; more moving parts than the meta+subprotocol path. Deferred.
- **Token required in dev too** — impossible to deliver without Node serving the dev HTML; would break the
  Vite dev workflow. Rejected in favor of Origin-only dev.
- **Gate per-message instead of at upgrade** — leaves the socket open to a foreign origin and re-checks on
  every frame; worse and more error-prone than rejecting the handshake. Rejected.
