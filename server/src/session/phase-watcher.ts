// Phase watcher — injectable seam mirroring SessionManager's signal fan-out
// (onContextUsage). Watches a project's `tasks/stories/<id>/phase.md` marker file
// for changes and fans out a PhaseTransitionSignal whenever the parsed phase
// differs from the last-seen phase for that session. Purely mechanical fan-out —
// holds NO pipeline logic.
//
// Never throws: fs.watch/readFileSync failures are caught and logged, never
// rethrown — a broken watcher for one session must never affect siblings.

import { watch, readFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Phase } from '../lifecycle/story-state-reader.js';
import { parsePhaseMarker } from '../lifecycle/story-state-reader.js';

// Cap on how much of a phase.md we read before giving up — mirrors the
// story-state-reader's bound against a pathological file.
const MAX_PHASE_MARKER_BYTES = 256 * 1024; // 256 KiB

const STORIES_REL_PATH = join('tasks', 'stories');
const PHASE_MARKER_FILE = 'phase.md';

/** Fired when a watched session's `phase.md` marker transitions to a new phase. */
export interface PhaseTransitionSignal {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly workItemId: string;
  readonly phase: Phase;
}

/** Fired on every genuine phase transition for a watched session. */
export type PhaseTransitionListener = (signal: PhaseTransitionSignal) => void;

export interface PhaseWatcher {
  /** Start watching a session's `phase.md` marker. Idempotent per sessionId (re-watch replaces). */
  watch(args: { sessionId: string; projectPath: string; workItemId: string }): void;
  /** Stop watching a session's marker and forget its last-seen phase. Guarded no-op if unknown. */
  unwatch(sessionId: string): void;
  /** Register a listener fired on every phase transition. Returns an unsubscribe fn. */
  onPhaseTransition(listener: PhaseTransitionListener): () => void;
  /** Stop watching every session. Called on server shutdown. */
  stopAll(): void;
}

/** One watched session's live fs.watch handle plus its last-seen phase. */
interface WatchedSession {
  readonly watcher: FSWatcher;
  readonly projectPath: string;
  readonly workItemId: string;
  lastPhase: Phase | null;
}

// Best-effort read + parse of a `phase.md` marker. Never throws — a missing/
// unreadable file or a malformed/unrecognized marker yields null.
function readPhase(projectPath: string, workItemId: string): Phase | null {
  try {
    const path = join(projectPath, STORIES_REL_PATH, workItemId, PHASE_MARKER_FILE);
    const raw = readFileSync(path, 'utf8');
    const content = raw.slice(0, MAX_PHASE_MARKER_BYTES);
    return parsePhaseMarker(content);
  } catch {
    return null;
  }
}

export function createPhaseWatcher(): PhaseWatcher {
  const sessions = new Map<string, WatchedSession>();
  const listeners = new Set<PhaseTransitionListener>();

  const emit = (signal: PhaseTransitionSignal): void => {
    for (const listener of listeners) {
      try {
        listener(signal);
      } catch (err) {
        console.error('[phase-watcher] listener threw', err);
      }
    }
  };

  const watchSession = (args: { sessionId: string; projectPath: string; workItemId: string }): void => {
    const { sessionId, projectPath, workItemId } = args;

    // Re-watching an already-watched session replaces its handle cleanly.
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      try {
        existing.watcher.close();
      } catch (err) {
        console.error(`[phase-watcher] failed to close existing watcher for ${sessionId}`, err);
      }
      sessions.delete(sessionId);
    }

    const path = join(projectPath, STORIES_REL_PATH, workItemId, PHASE_MARKER_FILE);
    const dir = join(projectPath, STORIES_REL_PATH, workItemId);

    let fsWatcher: FSWatcher;
    try {
      // Watch the story directory (not the file directly) so the watcher survives
      // the marker file not existing yet at watch-time.
      fsWatcher = watch(dir, (_eventType, filename) => {
        try {
          // `filename` may be undefined on some platforms — fall back to always checking.
          if (filename !== undefined && filename !== PHASE_MARKER_FILE) return;
          const session = sessions.get(sessionId);
          if (session === undefined) return;

          const phase = readPhase(session.projectPath, session.workItemId);
          if (phase === null) return;
          if (phase === session.lastPhase) return;

          session.lastPhase = phase;
          emit(
            Object.freeze<PhaseTransitionSignal>({
              sessionId,
              projectPath: session.projectPath,
              workItemId: session.workItemId,
              phase,
            }),
          );
        } catch (err) {
          console.error(`[phase-watcher] change handler for ${sessionId} threw`, err);
        }
      });
    } catch (err) {
      console.error(`[phase-watcher] failed to watch ${path}`, err);
      return;
    }

    fsWatcher.on('error', (err) => {
      console.error(`[phase-watcher] watcher for ${sessionId} errored`, err);
    });

    sessions.set(sessionId, {
      watcher: fsWatcher,
      projectPath,
      workItemId,
      lastPhase: readPhase(projectPath, workItemId),
    });
  };

  const unwatch = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    try {
      session.watcher.close();
    } catch (err) {
      console.error(`[phase-watcher] failed to close watcher for ${sessionId}`, err);
    }
    sessions.delete(sessionId);
  };

  const onPhaseTransition = (listener: PhaseTransitionListener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const stopAll = (): void => {
    for (const sessionId of [...sessions.keys()]) {
      unwatch(sessionId);
    }
  };

  return Object.freeze<PhaseWatcher>({
    watch: watchSession,
    unwatch,
    onPhaseTransition,
    stopAll,
  });
}
