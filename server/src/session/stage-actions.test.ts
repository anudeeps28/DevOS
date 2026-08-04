// Unit tests — kick-off-next-stage action map validation.

import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_STAGE_WORDS,
  isValidStageWord,
  kickoffPromptForStage,
  type LifecycleStageWord,
} from './stage-actions.js';

describe('LIFECYCLE_STAGE_WORDS', () => {
  it('matches the five lifecycle stages', () => {
    expect(LIFECYCLE_STAGE_WORDS).toEqual(['New', 'Decide', 'Define', 'Build', 'Ship']);
  });
});

describe('kickoffPromptForStage', () => {
  it('maps every documented stage to its kickoff prompt (ARCHITECTURE §9.3)', () => {
    expect(kickoffPromptForStage('New')).toBe('/grill-me');
    expect(kickoffPromptForStage('Decide')).toBe('/architect');
    expect(kickoffPromptForStage('Define')).toBe('/implement');
    expect(kickoffPromptForStage('Ship')).toBe('/improve-harness');
  });

  it('goes quiet (null) in Build — no spawn', () => {
    expect(kickoffPromptForStage('Build')).toBeNull();
  });

  it('returns null for a non-word cast (defense-in-depth)', () => {
    expect(kickoffPromptForStage('Bogus' as unknown as LifecycleStageWord)).toBeNull();
  });
});

describe('isValidStageWord', () => {
  it('accepts every canonical stage word', () => {
    for (const stage of LIFECYCLE_STAGE_WORDS) {
      expect(isValidStageWord(stage)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isValidStageWord('Learn')).toBe(false);
    expect(isValidStageWord('new')).toBe(false); // case-sensitive
    expect(isValidStageWord('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidStageWord(undefined)).toBe(false);
    expect(isValidStageWord(null)).toBe(false);
    expect(isValidStageWord(42)).toBe(false);
    expect(isValidStageWord({ stage: 'New' })).toBe(false);
  });
});
