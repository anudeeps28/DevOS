// End-to-end acceptance for the Fleet tab: derived state + persona + simulated
// plan-limit + two-never-flattened lanes (work item -> session -> subagents).
//
// Drives the BUILT prod app (single Node process: static web/dist + /ws on the
// same origin/port), same pattern as projects-grid.spec.ts. The server's
// DEVOS_E2E_FLEET_FIXTURE fixture seam seeds a deterministic canned fleet
// (builder running, reviewer rateLimited) through the real WS frames on every
// new client connection — no live SDK needed.
//
// The fixture's session-state / session-personas / session-transcript frames
// are sent DIRECTLY to the connecting socket (see sendFleetFixture in
// server/src/ws-gateway.ts) and are folded into useProjects' `sessions` /
// `sessionPersonas` / `transcripts` state UNCONDITIONALLY on receipt (see
// useProjects.ts onSessionState / onSessionPersonas / onSessionTranscript) —
// this fold does NOT gate on the fixture's path being pinned. So this spec
// does not need to pin the fixture path for the Fleet lanes to render.
//
// A throwaway fixture tree + DB are still used for the regression assertion
// (Projects tab still shows the pinned project area), mirroring
// projects-grid.spec.ts. The DB is likewise redirected to a throwaway tmp
// file, so the test NEVER touches the real app-data database.
//
// Runs serially (playwright.config.ts pins workers:1).

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

const dbPath = path.join(os.tmpdir(), `devos-e2e-fleet-${randomUUID()}.db`);

// A throwaway fixture project root, unique per run. Contains a single project:
//   proj/ → has a .claude/ dir → SHOULD surface as a discovery candidate.
const fixtureRoot = path.join(os.tmpdir(), `devos-e2e-fleet-roots-${randomUUID()}`);
const projectPath = path.join(fixtureRoot, 'proj');

let harness: ServerHarness;

test.beforeAll(async () => {
  // Build the fixture tree first so discovery has something real to find.
  await mkdir(path.join(projectPath, '.claude'), { recursive: true });

  harness = createServerHarness({
    extraEnv: {
      DEVOS_DB_PATH: dbPath,
      DEVOS_PROJECT_ROOTS: fixtureRoot,
      DEVOS_E2E_FLEET_FIXTURE: '1',
    },
  });
  await harness.start();
});

test.afterAll(async () => {
  // Stop the server first so all SQLite handles (and WAL/SHM) are released.
  if (harness !== undefined) {
    await harness.stop();
  }
  // Remove the throwaway DB and its WAL/SHM sidecars — best-effort cleanup.
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  // Remove the fixture tree — best-effort cleanup.
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('Fleet tab renders derived state + persona + simulated plan-limit + two-level lanes', async ({
  page,
}) => {
  await page.goto(harness.url);

  // Pin a real project first so the Projects/Inbox regression assertions have
  // something concrete to check later in this same session.
  await page.getByTestId('discover-refresh').click();
  await expect(page.getByTestId(`candidate-${projectPath}`)).toBeVisible();
  await page.getByTestId(`candidate-pin-${projectPath}`).click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`),
  ).toBeVisible();

  // Switch to the Fleet tab.
  await page.getByTestId('tab-fleet').click();

  const workItem = page.locator('[data-testid="fleet-workitem"][data-workitem="WI-1"]');
  await expect(workItem).toBeVisible();

  // (a) builder session — derived state "running" + persona "Shipwright".
  const builderSession = workItem.locator('[data-testid="fleet-session"][data-role="builder"]');
  await expect(builderSession).toHaveAttribute('data-derived-state', 'running');
  await expect(builderSession.getByTestId('fleet-persona')).toHaveText('Shipwright');

  // (a) reviewer session — persona "Warden".
  const reviewerSession = workItem.locator('[data-testid="fleet-session"][data-role="reviewer"]');
  await expect(reviewerSession.getByTestId('fleet-persona')).toHaveText('Warden');

  // (b) simulated plan-limit: reviewer session shows "waiting — plan limit" text
  // and data-derived-state="waiting-on-rate-limit".
  await expect(reviewerSession).toHaveAttribute('data-derived-state', 'waiting-on-rate-limit');
  await expect(reviewerSession).toContainText('waiting — plan limit');

  // (c) two never-flattened levels: fleet-workitem > fleet-session > distinct
  // fleet-subagents level, with the builder's Task subagent visible INSIDE its
  // own session (not hoisted to the work-item level).
  const builderSubagents = builderSession.getByTestId('fleet-subagents');
  await expect(builderSubagents).toBeVisible();
  await expect(builderSubagents.getByTestId('fleet-subagent')).toHaveCount(1);
  // The reviewer session has no Task tool-use events, so its subagents lane is
  // present but empty — proving subagents are scoped per-session, not hoisted.
  const reviewerSubagents = reviewerSession.getByTestId('fleet-subagents');
  await expect(reviewerSubagents).toBeVisible();
  await expect(reviewerSubagents.getByTestId('fleet-subagent')).toHaveCount(0);

  // Regression: the peer tabs still work.
  await page.getByTestId('tab-projects').click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`),
  ).toBeVisible();

  await page.getByTestId('tab-inbox').click();
  await expect(page.getByTestId('needs-you-inbox')).toBeVisible();
});
