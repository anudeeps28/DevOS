// Unit tests — role roster validation.

import { describe, expect, it } from 'vitest';
import { VALID_ROLES, isValidRole } from './roles.js';

describe('isValidRole', () => {
  it('accepts every canonical pipeline role', () => {
    for (const role of VALID_ROLES) {
      expect(isValidRole(role)).toBe(true);
    }
    expect(VALID_ROLES).toEqual(['builder', 'reviewer']);
  });

  it('rejects unknown strings', () => {
    expect(isValidRole('shipwright')).toBe(false);
    expect(isValidRole('Builder')).toBe(false); // case-sensitive
    expect(isValidRole('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidRole(undefined)).toBe(false);
    expect(isValidRole(null)).toBe(false);
    expect(isValidRole(42)).toBe(false);
    expect(isValidRole({ role: 'builder' })).toBe(false);
  });
});
