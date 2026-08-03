// End-to-end acceptance for the Board (kanban) tab: phase->column placement,
// loop-back placement by CURRENT phase, Merged (bridge gate 'done' + owns
// session), Queued (tracker nextTask with no active session), and card-click
// opening Work-item Detail.
//
// Drives the BUILT prod app (single Node process: static web/dist + /ws on the
// same origin/port), same pattern as fleet.spec.ts. The server's
// DEVOS_E2E_BOARD_FIXTURE fixture seam seeds a deterministic canned board
// (see sendBoardFixture in server/src/ws-gateway.ts) through the real WS
// frames on every new client connection — no live SDK needed.
//
// A throwaway fixture tree + DB are still used for the regression assertion
// (Projects tab still shows the pinned project), mirroring fleet.spec.ts. The
// DB is likewise redirected to a throwaway tmp file, so the test NEVER touches
// the real app-data database.
//
// Runs serially (playwright.config.ts pins workers:1).

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

const dbPath = path.join(os.tmpdir(), `devos-e2e-board-${randomUUID()}.db`);

// A throwaway fixture project root, unique per run. Contains a single project:
//   proj/ → has a .claude/ dir → SHOULD surface as a discovery candidate.
const fixtureRoot = path.join(os.tmpdir(), `devos-e2e-board-roots-${randomUUID()}`);
const projectPath = path.join(fixtureRoot, 'proj');

let harness: ServerHarness;

test.beforeAll(async () => {
  // Build the fixture tree first so discovery has something real to find.
  await mkdir(path.join(projectPath, '.claude'), { recursive: true });

  harness = createServerHarness({
    extraEnv: {
      DEVOS_DB_PATH: dbPath,
      DEVOS_PROJECT_ROOTS: fixtureRoot,
      DEVOS_E2E_BOARD_FIXTURE: '1',
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

test('Board tab places cards by current phase, Merged, Queued, and opens Detail on click', async ({
  page,
}) => {
  await page.goto(harness.url);

  // Pin a real project first so the Projects/Fleet/Inbox regression assertions
  // have something concrete to check later in this same session.
  await page.getByTestId('discover-refresh').click();
  await expect(page.getByTestId(`candidate-${projectPath}`)).toBeVisible();
  await page.getByTestId(`candidate-pin-${projectPath}`).click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`),
  ).toBeVisible();

  // Switch to the Board tab.
  await page.getByTestId('tab-board').click();

  // (1) Phase -> column: each single-phase work item lands in its matching column.
  const phaseToColumnAndItem: readonly { workItemId: string; column: string }[] = [
    { workItemId: 'WI-PLAN', column: 'planning' },
    { workItemId: 'WI-CODE', column: 'coding' },
    { workItemId: 'WI-TEST', column: 'testing' },
    { workItemId: 'WI-REVIEW', column: 'reviewing' },
    { workItemId: 'WI-PR', column: 'shipping' },
  ];
  for (const { workItemId, column } of phaseToColumnAndItem) {
    // Assert both the column placement AND the card's own data-phase face
    // (the observability plan checks the phase label, not only the column).
    await expect(
      page.locator(
        `[data-testid="board-column"][data-column="${column}"] [data-testid="board-card"][data-workitem="${workItemId}"][data-phase="${column}"]`,
      ),
    ).toBeVisible();
  }

  // (2) Loop-back: WI-LOOP's current phase is 'coding' — it must appear in
  // Coding and must NOT appear in Testing.
  await expect(
    page.locator(
      '[data-testid="board-column"][data-column="coding"] [data-testid="board-card"][data-workitem="WI-LOOP"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-testid="board-column"][data-column="testing"] [data-testid="board-card"][data-workitem="WI-LOOP"]',
    ),
  ).toHaveCount(0);

  // (3) Merged: WI-MERGED's bridge gate is 'done' and it owns the bridge
  // session — it must appear in Merged.
  await expect(
    page.locator(
      '[data-testid="board-column"][data-column="merged"] [data-testid="board-card"][data-workitem="WI-MERGED"]',
    ),
  ).toBeVisible();

  // (4) Queued: WI-QUEUED has no session/persona — it surfaces only via the
  // tracker's nextTask and must appear in Queued with the tracker task title.
  const queuedCard = page.locator(
    '[data-testid="board-column"][data-column="queued"] [data-testid="board-card"][data-workitem="WI-QUEUED"]',
  );
  await expect(queuedCard).toBeVisible();
  await expect(queuedCard).toContainText('Queued task title');

  // (5) Click WI-CODE's card -> the Work-item Detail overlay becomes visible.
  await page
    .locator('[data-testid="board-card"][data-workitem="WI-CODE"]')
    .click();
  await expect(
    page.locator('[data-testid="work-item-detail"][data-workitem="WI-CODE"]'),
  ).toBeVisible();
  await page.getByTestId('detail-back').click();

  // Regression: the peer tabs still work.
  await page.getByTestId('tab-projects').click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`),
  ).toBeVisible();

  await page.getByTestId('tab-fleet').click();
  await expect(page.getByTestId('tab-fleet')).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('tab-inbox').click();
  await expect(page.getByTestId('needs-you-inbox')).toBeVisible();
});
