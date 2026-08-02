// Context-usage watcher — pure occupancy calculation against a model's context window.
//
// Operates on the SETTLED token proxy: the latest turn result's token total, not a running
// cumulative sum. No side effects, never throws.

/** Default context window size in tokens, used when a model has no explicit override. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Exact-id context window overrides — a seam for a model id whose window is NOT derivable from a
 * bracketed `[Nm]` hint. Checked before the `[Nm]` parse. Currently empty: every known 1M model id
 * (`claude-opus-4-8[1m]`, `claude-opus-5[1m]`, …) already advertises `[1m]`, so the generic rule
 * below covers them without a hardcoded entry.
 */
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {};

/** Matches a trailing `[<N>m]` context-window hint, e.g. `claude-opus-5[1m]` → N million tokens. */
const MILLION_CONTEXT_HINT = /\[(\d+)m\]$/i;

/** Upper bound on the parsed `[Nm]` million-token hint — rejects absurd ids that would disable recycling. */
const MAX_MILLION_HINT = 100;

/**
 * Upper bound on any resolved context window (tokens). A window larger than this pushes the recycle
 * threshold so high it never fires — silently disabling the runaway-context brake — so a declared
 * window above this ceiling is treated as invalid. Mirrors the `[Nm]` marker's `MAX_MILLION_HINT` cap.
 */
export const MAX_CONTEXT_WINDOW = MAX_MILLION_HINT * 1_000_000;

/** Fraction of the context window occupied at which callers should warn. */
export const CONTEXT_THRESHOLD = 0.8;

/** Occupancy snapshot for a single settled token total against a model's window. */
export interface ContextOccupancy {
  readonly occupiedTokens: number;
  readonly windowTokens: number;
  readonly fraction: number;
}

/** Raw per-turn token counts used to derive the settled context total. */
export interface ContextResultTokens {
  readonly inputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

function clampNonNegativeFinite(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

/**
 * Whether this model's context window is known from real information — an exact-id override or
 * the `[Nm]` marker — rather than the silent 200k default. Used to warn once when a session
 * would otherwise recycle against a guessed window (see `effectiveWindow`).
 */
export function isKnownContextWindow(model: string): boolean {
  if (MODEL_CONTEXT_WINDOWS[model] !== undefined) return true;
  const match = MILLION_CONTEXT_HINT.exec(model);
  if (match === null) return false;
  const millions = Number(match[1]);
  return Number.isFinite(millions) && millions > 0 && millions <= MAX_MILLION_HINT;
}

/**
 * Resolves the context window size for a model id, falling back to the default.
 * Precedence: exact-id override → `[Nm]` marker (e.g. `claude-opus-5[1m]` → N million) → default.
 * This is only a fallback for sessions with no roster-declared window — see `effectiveWindow`.
 */
export function windowFor(model: string): number {
  const override = MODEL_CONTEXT_WINDOWS[model];
  if (override !== undefined) {
    return override;
  }
  const match = MILLION_CONTEXT_HINT.exec(model);
  if (match !== null) {
    const millions = Number(match[1]);
    if (Number.isFinite(millions) && millions > 0 && millions <= MAX_MILLION_HINT) {
      return millions * 1_000_000;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * The effective context window for a session. A roster-declared window (harness-roles.json
 * `contextWindow`) is authoritative and wins; otherwise fall back to `windowFor(model)`. A
 * declared window must be a positive finite number to count — an invalid one is ignored.
 *
 * Deliberately NOT validated against the model. A declared window is trusted on the ONLY axis we
 * can judge model-free: absolute plausibility (finite, positive, <= MAX_CONTEXT_WINDOW). We do not
 * check whether it MATCHES the model — e.g. a roster declaring 1,000,000 for a model that truly
 * holds 200,000 is accepted, so the recycle brake fires late and the session can hit the real
 * limit. Catching that requires a model->window table, which is exactly the coupling SPEC §3.1
 * moved out of DevOS to make the roster the single source of truth; re-adding it trades that
 * property away to catch a roster misconfiguration. A too-large declared window is a config error,
 * mitigated by the absolute ceiling here and surfaced (for the no-window case) via the
 * ContextConfigWarning inbox signal — not by DevOS second-guessing the roster. Deferred with the
 * full reasoning in Todoist 6hC5HMRGR59pg748 (revisit if roster-window misconfig becomes a real
 * incident; likely shape then is roster-reader-side validation, keeping model knowledge out here).
 */
export function effectiveWindow(declaredWindow: number | null | undefined, model: string): number {
  if (
    declaredWindow != null &&
    Number.isFinite(declaredWindow) &&
    declaredWindow > 0 &&
    declaredWindow <= MAX_CONTEXT_WINDOW
  ) {
    return declaredWindow;
  }
  return windowFor(model);
}

/** Computes context window occupancy for a settled token total against an explicit window size. */
export function contextOccupancy(totalTokens: number, windowTokens: number): ContextOccupancy {
  const occupiedTokens = clampNonNegativeFinite(totalTokens);
  const fraction = occupiedTokens / windowTokens;
  return { occupiedTokens, windowTokens, fraction };
}

/** True when the occupied fraction of the given window is at or above the threshold. */
export function crossesThreshold(
  totalTokens: number,
  windowTokens: number,
  threshold: number = CONTEXT_THRESHOLD,
): boolean {
  const { fraction } = contextOccupancy(totalTokens, windowTokens);
  return fraction >= threshold;
}

/** Sums the settled per-turn token counts into a single context total. */
export function contextTotalFromResult(body: ContextResultTokens): number {
  return (
    clampNonNegativeFinite(body.inputTokens) +
    clampNonNegativeFinite(body.cacheReadInputTokens) +
    clampNonNegativeFinite(body.cacheCreationInputTokens)
  );
}
