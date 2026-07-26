// Unit tests — role roster validation.

import { describe, expect, it } from 'vitest';
import { VALID_ROLES, isValidRole } from './roles.js';

describe('isValidRole', () => {
  it('accepts every canonical pipeline role', () => {
    for (const role of VALID_ROLES) {
      expect(isValidRole(role)).toBe(true);
    }
    expect(VALID_ROLES).toEqual(['navigator', 'shipwright', 'lookout', 'warden', 'harbormaster']);
  });

  it('rejects unknown strings', () => {
    expect(isValidRole('captain')).toBe(false);
    expect(isValidRole('Navigator')).toBe(false); // case-sensitive
    expect(isValidRole('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidRole(undefined)).toBe(false);
    expect(isValidRole(null)).toBe(false);
    expect(isValidRole(42)).toBe(false);
    expect(isValidRole({ role: 'navigator' })).toBe(false);
  });
});
