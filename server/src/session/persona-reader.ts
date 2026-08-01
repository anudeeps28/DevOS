// Persona-join reader — joins each owned session's (role, workItemId) against the
// project's role roster (harness-roles.json) and its story's live `phase.md`
// marker, yielding the display persona currently shown for that session (e.g.
// builder + coding → "Shipwright").
//
// Mirrors the codebase's "drop, don't throw / frozen-return" boundary-reader
// template (see roster-reader.ts, story-state-reader.ts): a missing/malformed
// roster, a missing/unreadable phase.md, or an unrecognized phase all yield a
// null persona for that session — readSessionPersonas NEVER throws.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { parsePhaseMarker, type Phase } from '../lifecycle/story-state-reader.js';
import type { SessionPersona } from '../ws-protocol.js';
import type { Role } from './roles.js';
import { readRoster } from './roster-reader.js';

const STORIES_REL_PATH = join('tasks', 'stories');
const PHASE_MARKER_FILE = 'phase.md';

// A workItemId is joined into a filesystem path below. The WS boundary already
// allowlists it (ws-protocol.ts isSafeWorkItemId), but this reader re-validates
// as defense-in-depth: a session-store row persisted before that boundary tightened
// could still carry a separator/`..`. Reject anything that isn't a single safe
// path segment so the read can never escape `tasks/stories/<id>/`.
const SAFE_WORK_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Cap on how much of a phase.md we read before giving up — a well-formed marker
// is a few dozen bytes; the cap defends against a pathological file.
const MAX_PHASE_MARKER_BYTES = 256 * 1024; // 256 KiB

/** The minimal shape of a live session this reader needs to join a persona for. */
export interface SessionForPersona {
  readonly sessionId: string;
  readonly workItemId: string | null;
  readonly role: string;
}

/**
 * Read and parse the `phase.md` marker of a single `tasks/stories/<id>/`
 * directory. Best-effort: a missing/unreadable file or a malformed/unrecognized
 * marker yields null. Never throws.
 */
async function readPhaseForStory(projectPath: string, workItemId: string): Promise<Phase | null> {
  // Defense-in-depth path-traversal guard — never join an unsafe segment.
  if (!SAFE_WORK_ITEM_ID_PATTERN.test(workItemId)) return null;
  try {
    const raw = await fs.readFile(
      join(projectPath, STORIES_REL_PATH, workItemId, PHASE_MARKER_FILE),
      'utf8',
    );
    return parsePhaseMarker(raw.slice(0, MAX_PHASE_MARKER_BYTES));
  } catch {
    return null;
  }
}

/**
 * Join each session's (role, workItemId) against the project's role roster and
 * its story's live phase marker. Reads the roster ONCE for the whole batch.
 * Best-effort per session: any failure yields `{ phase: null, persona: null }`
 * for that session, never throws, and never rejects.
 */
export async function readSessionPersonas(
  projectPath: string,
  sessions: readonly SessionForPersona[],
): Promise<readonly SessionPersona[]> {
  const roster = readRoster(projectPath);

  const personas = await Promise.all(
    sessions.map(async (s): Promise<SessionPersona> => {
      if (s.workItemId === null) {
        return Object.freeze<SessionPersona>({
          sessionId: s.sessionId,
          workItemId: null,
          role: s.role,
          phase: null,
          persona: null,
        });
      }

      const phase = await readPhaseForStory(projectPath, s.workItemId);
      const persona =
        phase === null
          ? null
          : (roster?.roles[s.role as Role]?.phases.find((p) => p.id === phase)?.displayName ?? null);

      return Object.freeze<SessionPersona>({
        sessionId: s.sessionId,
        workItemId: s.workItemId,
        role: s.role,
        phase,
        persona,
      });
    }),
  );

  return Object.freeze(personas);
}
