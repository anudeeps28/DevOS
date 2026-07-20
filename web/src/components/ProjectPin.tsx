import { useState } from 'react';

import { useProjects } from '@/hooks/useProjects';

/**
 * Minimal pin/unpin round-trip affordance: an absolute-path input + Pin button,
 * and a list of pinned projects each with its own Unpin button. This is the
 * transport round-trip only — NOT the full Projects Grid.
 */
export function ProjectPin() {
  const { projects, pin, unpin } = useProjects();
  const [path, setPath] = useState('');

  const trimmed = path.trim();
  const canPin = trimmed.length > 0;

  const handlePin = (): void => {
    if (!canPin) return;
    pin(trimmed);
    setPath('');
  };

  return (
    <div className="flex w-full max-w-md flex-col gap-3">
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
      <ul className="flex flex-col gap-1">
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
    </div>
  );
}
