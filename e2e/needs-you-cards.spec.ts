// End-to-end acceptance for the Needs-you Inbox tab: the Agent Question card
// (chips + free-text + Send answer, no plan-gate Approve button) and the
// Escalation card (Let debug try / Give guidance / Take over).
//
// Drives the BUILT prod app (single Node process: static web/dist + /ws on the
// same origin/port), same pattern as fleet.spec.ts. The server's
// DEVOS_E2E_INBOX_FIXTURE fixture seam sends a single deterministic bridge-state
// frame (gate='escalated') directly to the connecting socket (see
// sendInboxFixture in server/src/ws-gateway.ts) containing a chips-bearing
// question item and an escalation item. useProjects folds bridge-state frames
// into `bridgeStates` UNCONDITIONALLY on receipt (no pinning gate), and App
// passes `Object.values(bridgeStates)` straight into NeedsYouInbox — so this
// spec does not need to pin the fixture path for the cards to render.
//
// A throwaway fixture tree + DB are still used for the regression assertion
// (Projects tab still shows the pinned project area), mirroring fleet.spec.ts.
// The DB is likewise redirected to a throwaway tmp file, so the test NEVER
// touches the real app-data database.
//
// Runs serially (playwright.config.ts pins workers:1).

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

const dbPath = path.join(os.tmpdir(), `devos-e2e-needs-you-${randomUUID()}.db`);

// A throwaway fixture project root, unique per run. Contains a single project:
//   proj/ → has a .claude/ dir → SHOULD surface as a discovery candidate.
const fixtureRoot = path.join(os.tmpdir(), `devos-e2e-needs-you-roots-${randomUUID()}`);
const projectPath = path.join(fixtureRoot, 'proj');

let harness: ServerHarness;

test.beforeAll(async () => {
  // Build the fixture tree first so discovery has something real to find.
  await mkdir(path.join(projectPath, '.claude'), { recursive: true });

  harness = createServerHarness({
    extraEnv: {
      DEVOS_DB_PATH: dbPath,
      DEVOS_PROJECT_ROOTS: fixtureRoot,
      DEVOS_E2E_INBOX_FIXTURE: '1',
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

test('Needs-you inbox renders the Question and Escalation cards and they interact', async ({
  page,
}) => {
  await page.goto(harness.url);

  // Pin a real project first so the Projects regression assertion has
  // something concrete to check later in this same session.
  await page.getByTestId('discover-refresh').click();
  await expect(page.getByTestId(`candidate-${projectPath}`)).toBeVisible();
  await page.getByTestId(`candidate-pin-${projectPath}`).click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`),
  ).toBeVisible();

  // Switch to the Inbox tab.
  await page.getByTestId('tab-inbox').click();
  await expect(page.getByTestId('needs-you-inbox')).toBeVisible();

  // The fixture's inbox is [question (index 0), escalation (index 1)].
  const questionItem = page.getByTestId('needs-you-item-0');
  await expect(questionItem).toBeVisible();
  await expect(questionItem).toHaveAttribute('data-kind', 'question');

  // Agent Question card: two chip buttons, free-text input, Send answer.
  await expect(questionItem.getByTestId('needs-you-chip-0-0')).toBeVisible();
  await expect(questionItem.getByTestId('needs-you-chip-0-0')).toHaveText('Option A');
  await expect(questionItem.getByTestId('needs-you-chip-0-1')).toBeVisible();
  await expect(questionItem.getByTestId('needs-you-chip-0-1')).toHaveText('Option B');
  await expect(questionItem.getByTestId('needs-you-notes-0')).toBeVisible();
  await expect(questionItem.getByTestId('needs-you-answer-0')).toBeVisible();

  // The plan-gate "Approve" button must NOT be present on the question item —
  // the question card is a distinct affordance from the generic gate approval.
  await expect(questionItem.getByTestId('needs-you-approve-0')).toHaveCount(0);

  const escalationItem = page.getByTestId('needs-you-item-1');
  await expect(escalationItem).toBeVisible();
  await expect(escalationItem).toHaveAttribute('data-kind', 'escalation');

  // Escalation card: all three action buttons.
  await expect(escalationItem.getByTestId('needs-you-escalation-debug-1')).toBeVisible();
  await expect(escalationItem.getByTestId('needs-you-escalation-guidance-1')).toBeVisible();
  await expect(escalationItem.getByTestId('needs-you-escalation-takeover-1')).toBeVisible();

  // Interaction: clicking a chip must not error and the socket must stay
  // connected.
  await questionItem.getByTestId('needs-you-chip-0-0').click();
  await expect(page.getByTestId('needs-you-inbox')).toBeVisible();

  // Interaction: typing free-text and clicking Give guidance must not error.
  await escalationItem.getByTestId('needs-you-notes-1').fill('Investigate the failing test first.');
  await escalationItem.getByTestId('needs-you-escalation-guidance-1').click();
  await expect(page.getByTestId('needs-you-inbox')).toBeVisible();

  // Regression: the Projects tab still renders the pinned project area.
  await page.getByTestId('tab-projects').click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`),
  ).toBeVisible();
});
