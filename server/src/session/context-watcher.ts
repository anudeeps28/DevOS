// Context-usage watcher — pure occupancy calculation against a model's context window.
//
// Operates on the SETTLED token proxy: the latest turn result's token total, not a running
// cumulative sum. No side effects, never throws.

/** Default context window size in tokens, used when a model has no explicit override. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** The 1-million-token context window, keyed off the `[1m]` marker in a model id. */
export const ONE_MILLION_CONTEXT_WINDOW = 1_000_000;

/**
 * The marker every 1M-context model id carries (e.g. `claude-opus-5[1m]`,
 * `claude-opus-4-8[1m]`). Matching on the marker — rather than an exact version
 * string — means a new 1M model version keeps the correct window without a code
 * change, so the respawn cadence can't silently regress when the roster's model
 * is bumped.
 */
const ONE_MILLION_MARKER = '[1m]';

/** Explicit per-model context window overrides (checked before the `[1m]` marker). */
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {};

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
 * Resolves the context window size for a model. An explicit override wins; then any
 * id carrying the `[1m]` 1M-context marker resolves to 1,000,000 (so `claude-opus-5[1m]`
 * and future 1M versions are correct without a code change); otherwise the default.
 * A model whose real window is unknown to this map falls back to the default — see
 * `isKnownContextWindow` for the caller-side warning that keeps that fallback loud.
 */
export function windowFor(model: string): number {
  const override = MODEL_CONTEXT_WINDOWS[model];
  if (override !== undefined) return override;
  if (model.includes(ONE_MILLION_MARKER)) return ONE_MILLION_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Whether `windowFor` resolved this model from real knowledge (an override or the
 * `[1m]` marker) rather than the silent default. Callers use this to warn ONCE when a
 * session's model is unrecognized, so a future roster model that neither is listed nor
 * carries `[1m]` surfaces loudly instead of silently recycling at 80% of the 200k default.
 */
export function isKnownContextWindow(model: string): boolean {
  return MODEL_CONTEXT_WINDOWS[model] !== undefined || model.includes(ONE_MILLION_MARKER);
}

/** Computes context window occupancy for a settled token total against a model's window. */
export function contextOccupancy(totalTokens: number, model: string): ContextOccupancy {
  const occupiedTokens = clampNonNegativeFinite(totalTokens);
  const windowTokens = windowFor(model);
  const fraction = occupiedTokens / windowTokens;
  return { occupiedTokens, windowTokens, fraction };
}

/** True when the occupied fraction of the context window is at or above the threshold. */
export function crossesThreshold(
  totalTokens: number,
  model: string,
  threshold: number = CONTEXT_THRESHOLD,
): boolean {
  const { fraction } = contextOccupancy(totalTokens, model);
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
