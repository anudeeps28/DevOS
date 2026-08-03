// End-to-end acceptance for "Assign work": clicking a pinned project's
// assign-work button starts a Bridge run for the project's own top open
// tracker task and opens the work-item Detail screen for it.
//
// Drives the BUILT prod app (single Node process: static web/dist + /ws on the
// same origin/port), same pattern as pipeline-timeline.spec.ts. Unlike that
// spec (which uses the DEVOS_E2E_FLEET_FIXTURE canned-frame seam), this one
// drives a REAL bridge-start over the real WS transport — the server's
// `query` engine is swapped for the deterministic DEVOS_E2E_FAKE_QUERY seam
// (server/src/session/e2e-fake-query.ts) so no live SDK is needed.
//
// The fixture project tree carries:
//  - `.claude/harness-roles.json` — a real roster (builder → reviewer, same
//    shape as pipeline-timeline.spec.ts) so the Detail screen's pipeline
//    timeline has real stages to render.
//  - `.claude/.harness-manifest.json` — `{ "tracker": "todoist" }` so the
//    tracker-state read picks a backend.
//  - `.claude/trackers/active/get-sprint-issues.sh` — a canned adapter that
//    echoes a single open Todoist-shaped task, so `NextTaskLine` shows a real
//    next task and the assign-work button becomes eligible.
//
// A throwaway DB is used (redirected via DEVOS_DB_PATH), so the test NEVER
// touches the real app-data database. Runs serially (playwright.config.ts
// pins workers:1).

import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

const dbPath = path.join(os.tmpdir(), `devos-e2e-assign-work-${randomUUID()}.db`);

const FIXTURE_PROJECT_PATH = path.join(os.tmpdir(), 'devos-e2e-assign-work-fixture');
const FIXTURE_PROJECT_ROOT = path.dirname(FIXTURE_PROJECT_PATH);

// Must match WORK_ITEM_ID_PATTERN in server/src/ws-protocol.ts (^[A-Za-z0-9_-]+$).
const FIXTURE_WORK_ITEM_ID = 'WI-e2e-1';

const ROSTER = {
  schemaVersion: 2,
  pipeline: ['builder', 'reviewer'],
  roles: {
    builder: {
      displayName: 'Builder',
      skills: ['implement', 'run-tasks'],
      agent: 'builder',
      phases: [
        { id: 'planning', displayName: 'Navigator' },
        { id: 'coding', displayName: 'Shipwright' },
        { id: 'testing', displayName: 'Lookout' },
        { id: 'shipping', displayName: 'Harbormaster' },
      ],
      model: 'claude-opus-5[1m]',
      effort: 'medium',
      producesArtifacts: [],
    },
    reviewer: {
      displayName: 'Reviewer',
      skills: ['evaluate'],
      agent: 'reviewer',
      phases: [{ id: 'reviewing', displayName: 'Warden' }],
      model: 'claude-opus-5[1m]',
      effort: 'high',
      producesArtifacts: [],
    },
  },
};

const ADAPTER_SCRIPT = `#!/bin/bash
echo '[{"id":"${FIXTURE_WORK_ITEM_ID}","content":"Fix the thing","priority":4,"url":null}]'
`;

let harness: ServerHarness;

test.beforeAll(async () => {
  // Best-effort clean slate — a fixed path can carry a leftover dir from a
  // previous crashed run.
  await rm(FIXTURE_PROJECT_PATH, { recursive: true, force: true });
  await mkdir(path.join(FIXTURE_PROJECT_PATH, '.claude', 'trackers', 'active'), { recursive: true });
  await writeFile(
    path.join(FIXTURE_PROJECT_PATH, '.claude', 'harness-roles.json'),
    JSON.stringify(ROSTER, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(FIXTURE_PROJECT_PATH, '.claude', '.harness-manifest.json'),
    JSON.stringify({ tracker: 'todoist' }, null, 2),
    'utf8',
  );
  const adapterPath = path.join(FIXTURE_PROJECT_PATH, '.claude', 'trackers', 'active', 'get-sprint-issues.sh');
  await writeFile(adapterPath, ADAPTER_SCRIPT, 'utf8');
  await chmod(adapterPath, 0o755);

  harness = createServerHarness({
    extraEnv: {
      DEVOS_DB_PATH: dbPath,
      DEVOS_PROJECT_ROOTS: FIXTURE_PROJECT_ROOT,
      DEVOS_E2E_FAKE_QUERY: '1',
    },
  });
  await harness.start();
});

test.afterAll(async () => {
  // Stop the server first so all SQLite handles (and WAL/SHM) are released.
  if (harness !== undefined) {
    await harness.stop();
  }
  const { rmSync } = await import('node:fs');
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  await rm(FIXTURE_PROJECT_PATH, { recursive: true, force: true });
});

test('Assign work starts a Bridge run for the tracker next task and opens its Detail screen', async ({
  page,
}) => {
  await page.goto(harness.url);

  // Pin the real fixture project so the app requests its tracker-state and roster-timeline.
  await page.getByTestId('discover-refresh').click();
  await expect(page.getByTestId(`candidate-${FIXTURE_PROJECT_PATH}`)).toBeVisible();
  await page.getByTestId(`candidate-pin-${FIXTURE_PROJECT_PATH}`).click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${FIXTURE_PROJECT_PATH}"]`),
  ).toBeVisible();

  const assignButton = page.getByTestId(`assign-work-${FIXTURE_PROJECT_PATH}`);
  await expect(assignButton).toBeEnabled();

  await assignButton.click();

  // The Detail screen renders for the fixture's next open task.
  const detail = page.locator(`[data-testid="work-item-detail"][data-workitem="${FIXTURE_WORK_ITEM_ID}"]`);
  await expect(detail).toBeVisible();

  // The ordered pipeline-timeline stage list rendered from the real roster.
  const stages = detail.getByTestId('pipeline-stage');
  await expect(stages).toHaveCount(5);
});
