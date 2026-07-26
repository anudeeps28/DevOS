// Canonical role roster for owned sessions (SPEC §3.1).
//
// Each owned session carries a role identity — a stage-scoped role the Bridge
// spawns (Navigator/Shipwright/Lookout/Warden/Harbormaster). This list MIRRORS
// the `pipeline` array in `.claude/harness-roles.json` (the harness owns the
// canonical roster; DevOS validates against it). Keep the two in sync by hand —
// if the harness roster changes, update this constant.

export const VALID_ROLES = [
  'navigator',
  'shipwright',
  'lookout',
  'warden',
  'harbormaster',
] as const;

export type Role = (typeof VALID_ROLES)[number];

/** True when `x` is one of the known pipeline roles. Never throws. */
export function isValidRole(x: unknown): x is Role {
  return typeof x === 'string' && (VALID_ROLES as readonly string[]).includes(x);
}
