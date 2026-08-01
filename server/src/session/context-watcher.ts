// Context-usage watcher — pure occupancy calculation against a model's context window.
//
// Operates on the SETTLED token proxy: the latest turn result's token total, not a running
// cumulative sum. No side effects, never throws.

/** Default context window size in tokens, used when a model has no explicit override. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Per-model context window overrides. */
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-opus-4-8[1m]': 1_000_000,
};

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

/** Resolves the context window size for a model, falling back to the default. */
export function windowFor(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
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
