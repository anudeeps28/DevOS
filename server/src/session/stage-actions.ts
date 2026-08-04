// Server-authoritative "kick off next stage" action map (ARCHITECTURE §9.3).
//
// The whole-project lifecycle stage word list MIRRORS `LifecycleStage` in
// `web/src/lib/lifecycle.ts` (New→Decide→Define→Build→Ship). Keep the two in
// sync by hand — if the client stage list changes, update this constant.

export const LIFECYCLE_STAGE_WORDS = ['New', 'Decide', 'Define', 'Build', 'Ship'] as const;

export type LifecycleStageWord = (typeof LIFECYCLE_STAGE_WORDS)[number];

/** True when `x` is one of the known lifecycle stage words. Never throws. */
export function isValidStageWord(x: unknown): x is LifecycleStageWord {
  return typeof x === 'string' && (LIFECYCLE_STAGE_WORDS as readonly string[]).includes(x);
}

/**
 * Authoritative stage → kickoff slash-command prompt map (ARCHITECTURE §9.3).
 * `Build` maps to `null` — the launcher goes quiet in Build (no spawn); Ship
 * is emergent from PR/release activity, not launched from Build.
 */
const STAGE_KICKOFF_PROMPTS: Readonly<Record<LifecycleStageWord, string | null>> = Object.freeze({
  New: '/grill-me',
  Decide: '/architect',
  Define: '/implement',
  Build: null,
  Ship: '/improve-harness',
});

/**
 * The exact slash-command kickoff prompt for advancing out of `stage`, or
 * `null` when the launcher has no action for that stage (Build, or any value
 * not in the authoritative map — defense-in-depth).
 */
export function kickoffPromptForStage(stage: LifecycleStageWord): string | null {
  return STAGE_KICKOFF_PROMPTS[stage] ?? null;
}
