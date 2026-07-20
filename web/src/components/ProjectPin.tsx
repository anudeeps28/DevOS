import { useState } from 'react';

import { useProjects } from '@/hooks/useProjects';
import { cn } from '@/lib/utils';

/**
 * Project discovery + pin management. Renders three regions:
 *  - a "Discovered" section (refresh + candidate rows not yet pinned),
 *  - a "Pinned" grid of pinned projects (each with an Unpin button),
 *  - an empty state when nothing is pinned.
 * Also keeps the manual pin-by-typed-path affordance as a secondary path.
 * Render-only: all state lives in the useProjects hook; no local mutation.
 */
export function ProjectPin() {
  const { projects, candidates, pin, unpin, discover } = useProjects();
  const [path, setPath] = useState('');

  const trimmed = path.trim();
  const canPin = trimmed.length > 0;

  const handlePin = (): void => {
    if (!canPin) return;
    pin(trimmed);
    setPath('');
  };

  const pinnedPaths = new Set(projects.map((project) => project.path));
  const unpinnedCandidates = candidates.filter(
    (candidate) => !pinnedPaths.has(candidate.path),
  );

  return (
    <div className={cn('flex w-full max-w-md flex-col gap-4')}>
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Discovered
          </span>
          <button
            data-testid="discover-refresh"
            type="button"
            onClick={() => discover()}
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Refresh
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {unpinnedCandidates.map((candidate) => (
            <li
              key={candidate.path}
              data-testid={`candidate-${candidate.path}`}
              data-path={candidate.path}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5"
            >
              <span className="truncate font-mono text-sm">
                {candidate.displayName ?? candidate.path}
              </span>
              <button
                data-testid={`candidate-pin-${candidate.path}`}
                type="button"
                onClick={() =>
                  pin(
                    candidate.path,
                    candidate.displayName
                      ? { displayName: candidate.displayName }
                      : undefined,
                  )
                }
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Pin
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Projects
        </span>
        <div className="flex gap-2">
          <input
            data-testid="pin-path-input"
            type="text"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/absolute/path/to/project"
            className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm"
          />
          <button
            data-testid="pin-submit"
            type="button"
            onClick={handlePin}
            disabled={!canPin}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Pin
          </button>
        </div>
        {projects.length === 0 ? (
          <p
            data-testid="discovery-empty"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
          >
            No projects pinned yet — refresh discovery to find projects.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1">
            {projects.map((project) => (
              <li
                key={project.path}
                data-testid="project-item"
                data-path={project.path}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5"
              >
                <span className="truncate font-mono text-sm">{project.path}</span>
                <button
                  data-testid={`unpin-${project.path}`}
                  type="button"
                  onClick={() => unpin(project.path)}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Unpin
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
