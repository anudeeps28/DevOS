// Unit tests — context-watcher's pure occupancy math (no engine, no I/O).

import { describe, expect, it } from 'vitest';
import {
  CONTEXT_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
  contextOccupancy,
  contextTotalFromResult,
  crossesThreshold,
  windowFor,
} from './context-watcher.js';

describe('windowFor', () => {
  it('returns the 1M override for the known 1M-context model id', () => {
    expect(windowFor('claude-opus-4-8[1m]')).toBe(1_000_000);
  });

  it('falls back to DEFAULT_CONTEXT_WINDOW for any other model id', () => {
    expect(windowFor('inherit')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(windowFor('')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('returns the 1M window for the [1m] hint on other model ids', () => {
    expect(windowFor('claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(windowFor('claude-opus-5[1m]')).toBe(1_000_000);
  });

  it('resolves a higher million-token hint from the bracketed suffix', () => {
    expect(windowFor('some-model[2m]')).toBe(2_000_000);
  });

  it('falls back to DEFAULT_CONTEXT_WINDOW for an unknown model id with no hint', () => {
    expect(windowFor('claude-sonnet-9')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(windowFor('inherit')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(windowFor('')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('rejects an absurdly large [Nm] hint rather than disabling recycling', () => {
    // An out-of-range hint must fall back to the default, not yield a window so large
    // the recycle threshold can never fire.
    expect(windowFor('foo[999999999m]')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(windowFor('foo[101m]')).toBe(DEFAULT_CONTEXT_WINDOW);
    // The ceiling itself is still honoured.
    expect(windowFor('foo[100m]')).toBe(100_000_000);
  });
});

describe('contextTotalFromResult', () => {
  it('sums inputTokens + cacheReadInputTokens + cacheCreationInputTokens', () => {
    const total = contextTotalFromResult({
      inputTokens: 100,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 5,
    });
    expect(total).toBe(125);
  });

  it('clamps a negative field to 0 rather than letting it subtract from the sum', () => {
    const total = contextTotalFromResult({
      inputTokens: 100,
      cacheReadInputTokens: -50,
      cacheCreationInputTokens: 5,
    });
    expect(total).toBe(105);
  });

  it('clamps a NaN/non-finite field to 0', () => {
    const total = contextTotalFromResult({
      inputTokens: Number.NaN,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: Number.POSITIVE_INFINITY,
    });
    expect(total).toBe(20);
  });
});

describe('contextOccupancy', () => {
  it('computes occupiedTokens/windowTokens/fraction against the resolved window', () => {
    const occ = contextOccupancy(50_000, 'inherit');
    expect(occ).toEqual({
      occupiedTokens: 50_000,
      windowTokens: DEFAULT_CONTEXT_WINDOW,
      fraction: 50_000 / DEFAULT_CONTEXT_WINDOW,
    });
  });

  it('clamps a negative/non-finite total to 0 occupied tokens', () => {
    const occ = contextOccupancy(-10, 'inherit');
    expect(occ.occupiedTokens).toBe(0);
    expect(occ.fraction).toBe(0);
  });

  it('uses the 1M window for the 1M-context model', () => {
    const occ = contextOccupancy(500_000, 'claude-opus-4-8[1m]');
    expect(occ.windowTokens).toBe(1_000_000);
    expect(occ.fraction).toBe(0.5);
  });
});

describe('crossesThreshold', () => {
  it('is false below 80% of the window', () => {
    const total = DEFAULT_CONTEXT_WINDOW * 0.79;
    expect(crossesThreshold(total, 'inherit')).toBe(false);
  });

  it('is true at exactly 80% of the window (boundary is inclusive)', () => {
    const total = DEFAULT_CONTEXT_WINDOW * CONTEXT_THRESHOLD;
    expect(crossesThreshold(total, 'inherit')).toBe(true);
  });

  it('is true above 80% of the window', () => {
    const total = DEFAULT_CONTEXT_WINDOW * 0.95;
    expect(crossesThreshold(total, 'inherit')).toBe(true);
  });

  it('respects an explicit threshold override', () => {
    const total = DEFAULT_CONTEXT_WINDOW * 0.5;
    expect(crossesThreshold(total, 'inherit', 0.5)).toBe(true);
    expect(crossesThreshold(total, 'inherit', 0.51)).toBe(false);
  });
});
