import { describe, expect, it } from 'vitest';

import { resolveStage } from '@/lib/lifecycle';
import type { LifecycleSignals, TrackerState } from '@/lib/ws-client';

function signals(overrides: Partial<LifecycleSignals> = {}): LifecycleSignals {
  return {
    hasDecideDocs: false,
    hasDefineDocs: false,
    hasStartedStory: false,
    hasFeatureBranchCommits: false,
    hasReleaseTags: false,
    ...overrides,
  };
}

function tracker(overrides: Partial<TrackerState> = {}): TrackerState {
  return {
    path: '/abs/repo',
    reachable: true,
    tracker: 'todoist',
    nextTask: { id: '101', title: 'Build the thing', priority: 4, url: null },
    ...overrides,
  };
}

describe('resolveStage — signals only', () => {
  it('all-false signals + no tracker → New', () => {
    expect(resolveStage(signals(), undefined)).toBe('New');
  });

  it('hasDecideDocs → Decide', () => {
    expect(resolveStage(signals({ hasDecideDocs: true }), undefined)).toBe('Decide');
  });

  it('hasDefineDocs → Define', () => {
    expect(resolveStage(signals({ hasDefineDocs: true }), undefined)).toBe('Define');
  });

  it('a started story or a feature branch → Build', () => {
    expect(resolveStage(signals({ hasStartedStory: true }), undefined)).toBe('Build');
    expect(resolveStage(signals({ hasFeatureBranchCommits: true }), undefined)).toBe('Build');
  });

  it('a release tag → Ship', () => {
    expect(resolveStage(signals({ hasReleaseTags: true }), undefined)).toBe('Ship');
  });

  it('takes the MAX precedence — Build beats Define', () => {
    expect(resolveStage(signals({ hasDefineDocs: true, hasStartedStory: true }), undefined)).toBe(
      'Build',
    );
  });

  it('takes the MAX precedence — Ship beats everything', () => {
    expect(
      resolveStage(
        signals({ hasDecideDocs: true, hasDefineDocs: true, hasStartedStory: true, hasReleaseTags: true }),
        undefined,
      ),
    ).toBe('Ship');
  });
});

describe('resolveStage — tracker reuse', () => {
  it('a reachable tracker whose only open task is a wayfinder:map item → Decide (not Define)', () => {
    // Regression: a wayfinder:map task is the Decide signal ONLY — it must not also
    // fire the Define "decomposed-unstarted" signal and get outranked into Define.
    const t = tracker({ nextTask: { id: 'wayfinder:map:x', title: 'Map', priority: 4, url: null } });
    expect(resolveStage(signals(), t)).toBe('Decide');
  });

  it('a reachable tracker with a regular open task → Define', () => {
    expect(resolveStage(signals(), tracker())).toBe('Define');
  });

  it('an unreachable tracker contributes no signal (falls to the local floor)', () => {
    const t = tracker({ reachable: false, tracker: null, nextTask: null });
    expect(resolveStage(signals(), t)).toBe('New');
    // ...and does not suppress local signals.
    expect(resolveStage(signals({ hasStartedStory: true }), t)).toBe('Build');
  });

  it('a reachable tracker with no open task contributes nothing', () => {
    expect(resolveStage(signals(), tracker({ nextTask: null }))).toBe('New');
  });

  it('local Build signal outranks a tracker Define/Decide signal', () => {
    expect(resolveStage(signals({ hasStartedStory: true }), tracker())).toBe('Build');
  });
});
