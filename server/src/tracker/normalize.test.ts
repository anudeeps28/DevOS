// Unit tests for the quarantined tracker normalizer.
//
// normalizeNextTask is the ONE module with tracker-specific logic: given a
// project's manifest `tracker` field and the raw stdout of that project's adapter
// script, it returns the top open TrackerTask (or null). It guards JSON.parse,
// validates every field at the boundary, and NEVER throws.

import { describe, expect, it } from 'vitest';

import { normalizeNextTask } from './normalize.js';

describe('normalizeNextTask', () => {
  describe('todoist', () => {
    it('returns the highest-priority non-milestone item mapped to {id,title,priority,url}', () => {
      // Given: a Todoist payload with several tasks at mixed priorities
      // (4 = p1 highest … 1 = p4 lowest), plus one milestone at the top priority.
      const stdout = JSON.stringify([
        { id: 101, content: 'Low priority task', priority: 1 },
        {
          id: 202,
          content: 'Top priority task',
          priority: 4,
          url: 'https://todoist.com/task/202',
        },
        { id: 303, content: 'Milestone container', priority: 4, isUncompletable: true },
        { id: 404, content: 'Mid priority task', priority: 2 },
      ]);

      // When: normalizing for the todoist backend
      const task = normalizeNextTask('todoist', stdout);

      // Then: the highest-priority NON-milestone item is returned, fully mapped
      expect(task).not.toBeNull();
      expect(task).toEqual({
        id: '202',
        title: 'Top priority task',
        priority: 4,
        url: 'https://todoist.com/task/202',
      });
    });

    it('coerces id/title to strings and collapses non-number priority / non-string url to null', () => {
      // Given: a single task whose priority and url are absent
      const stdout = JSON.stringify([{ id: 55, content: 'Only task' }]);

      // When: normalizing for todoist
      const task = normalizeNextTask('todoist', stdout);

      // Then: id/title become strings; missing priority/url collapse to null
      expect(task).toEqual({ id: '55', title: 'Only task', priority: null, url: null });
    });

    it('rejects a task missing id or content instead of coercing to "undefined"', () => {
      // Given: the highest-priority entry lacks an id, the next lacks content;
      // only the last is a real task.
      const stdout = JSON.stringify([
        { content: 'No id here', priority: 4 },
        { id: 7, priority: 3 },
        { id: 9, content: 'Real task', priority: 2 },
      ]);

      // When: normalizing for todoist
      const task = normalizeNextTask('todoist', stdout);

      // Then: the malformed high-priority entries are dropped (never surfaced as
      // {id:"undefined"} / {title:"undefined"}); the real lower-priority task wins.
      expect(task).toEqual({ id: '9', title: 'Real task', priority: 2, url: null });
    });

    it('returns null when no entry has both an id and content', () => {
      const stdout = JSON.stringify([{ content: 'no id' }, { id: 5 }, { priority: 4 }]);
      expect(normalizeNextTask('todoist', stdout)).toBeNull();
    });

    it('excludes an uncompletable/milestone item even when it has the highest priority', () => {
      // Given: the highest-priority item is a milestone; a lower-priority real task exists
      const stdout = JSON.stringify([
        { id: 1, content: 'Milestone', priority: 4, isUncompletable: true },
        { id: 2, content: 'Real work', priority: 2 },
      ]);

      // When: normalizing for todoist
      const task = normalizeNextTask('todoist', stdout);

      // Then: the milestone is skipped and the real task is chosen
      expect(task).not.toBeNull();
      expect(task?.id).toBe('2');
      expect(task?.title).toBe('Real work');
      expect(task?.priority).toBe(2);
    });

    it('returns null when every item is a milestone', () => {
      // Given: a payload made up entirely of uncompletable items
      const stdout = JSON.stringify([
        { id: 1, content: 'M1', priority: 4, isUncompletable: true },
        { id: 2, content: 'M2', priority: 3, isUncompletable: true },
      ]);

      // When/Then: no eligible candidate → null
      expect(normalizeNextTask('todoist', stdout)).toBeNull();
    });

    it('returns null for an empty array', () => {
      expect(normalizeNextTask('todoist', '[]')).toBeNull();
    });

    it('returns a frozen TrackerTask', () => {
      const stdout = JSON.stringify([{ id: 1, content: 'Task', priority: 4 }]);
      const task = normalizeNextTask('todoist', stdout);
      expect(task).not.toBeNull();
      expect(Object.isFrozen(task)).toBe(true);
    });
  });

  describe('malformed / non-array stdout', () => {
    it('returns null for non-JSON stdout (never throws)', () => {
      expect(normalizeNextTask('todoist', 'not json at all')).toBeNull();
    });

    it('returns null for empty stdout', () => {
      expect(normalizeNextTask('todoist', '')).toBeNull();
    });

    it('returns null for a JSON object (non-array payload)', () => {
      expect(normalizeNextTask('todoist', '{"error":"boom"}')).toBeNull();
    });
  });

  describe('unknown tracker', () => {
    it("returns null for an unsupported backend (e.g. 'github')", () => {
      // Given: a perfectly valid task array but an unsupported backend key
      const stdout = JSON.stringify([{ id: 1, content: 'Task', priority: 4 }]);

      // When/Then: unknown backends are unsupported → null
      expect(normalizeNextTask('github', stdout)).toBeNull();
    });

    it('returns null for an empty tracker string', () => {
      const stdout = JSON.stringify([{ id: 1, content: 'Task', priority: 4 }]);
      expect(normalizeNextTask('', stdout)).toBeNull();
    });
  });
});
