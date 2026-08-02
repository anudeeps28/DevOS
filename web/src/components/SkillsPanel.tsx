import { useEffect } from 'react';

import type { RegistryProject, Skill } from '@/lib/ws-client';
import { cn } from '@/lib/utils';

/** One skill row: name + description. */
function SkillRow({ skill }: { skill: Skill }): JSX.Element {
  return (
    <li
      data-testid={`skill-${skill.name}`}
      className="flex flex-col gap-0.5 rounded-md border border-border bg-card p-2"
    >
      <span className="text-sm font-medium text-foreground">{skill.name}</span>
      <span className="text-xs text-muted-foreground">{skill.description}</span>
    </li>
  );
}

/** A labelled group of skills (org or local scope). */
function SkillGroup({
  scope,
  label,
  skills,
}: {
  scope: 'org' | 'local';
  label: string;
  skills: readonly Skill[];
}): JSX.Element {
  return (
    <div data-testid={`skills-group-${scope}`} className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {skills.length === 0 ? (
        <span className="text-[10px] italic text-muted-foreground/60">no {label.toLowerCase()} skills</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {skills.map((skill) => (
            <SkillRow key={skill.name} skill={skill} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Presentational skills panel: one section per pinned project, each split
 * into an org-scoped and a local-scoped group. All state lives upstream in
 * useProjects; this component only renders and re-requests skills on mount
 * or when the project list changes.
 */
export function SkillsPanel({
  projects,
  skills,
  requestSkills,
}: {
  projects: readonly RegistryProject[];
  skills: Record<string, readonly Skill[]>;
  requestSkills: (path: string) => void;
}): JSX.Element {
  const pinnedProjects = projects.filter((project) => project.pinned);
  const pinnedKey = pinnedProjects.map((project) => project.path).join('\n');

  useEffect(() => {
    for (const project of pinnedProjects) {
      requestSkills(project.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedKey]);

  if (pinnedProjects.length === 0) {
    return (
      <p
        data-testid="skills-panel"
        className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
      >
        No projects pinned yet.
      </p>
    );
  }

  return (
    <div data-testid="skills-panel" className={cn('flex w-full max-w-md flex-col gap-3')}>
      {pinnedProjects.map((project) => {
        const projectSkills = skills[project.path] ?? [];
        const orgSkills = projectSkills.filter((skill) => skill.scope === 'org');
        const localSkills = projectSkills.filter((skill) => skill.scope === 'local');

        return (
          <section
            key={project.path}
            data-testid="skills-project"
            data-project={project.path}
            className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3"
          >
            <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {project.displayName ?? project.path}
            </span>
            {projectSkills.length === 0 ? (
              <span className="text-xs italic text-muted-foreground/60">no skills</span>
            ) : (
              <>
                <SkillGroup scope="org" label="Org" skills={orgSkills} />
                <SkillGroup scope="local" label="Local" skills={localSkills} />
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
