// End-to-end acceptance for the Needs-you Inbox's cross-project, cross-source sort
// and the LeftRail Inbox badge count.
//
// Drives the BUILT prod app (single Node process: static web/dist + /ws on the
// same origin/port), same pattern as needs-you-cards.spec.ts. The server's
// DEVOS_E2E_INBOX_FIXTURE fixture seam (see sendInboxFixture in
// server/src/ws-gateway.ts) seeds blocked items across TWO distinct fixture
// project paths, plus a permission request and a foreign-session signal, each
// with a distinct KNOWN `ts` so the merged (longest-wait-first) order is exactly
// predictable: question, escalation, second-project item, permission request,
// foreign session — in that order. useProjects folds every one of these frame
// types UNCONDITIONALLY on receipt (no pinning gate), and App passes the merged,
// sorted list straight into NeedsYouInbox — so this spec does not need to pin
// either fixture path for the cards to render.
//
// A throwaway fixture tree + DB are still used for the regression assertion
// (Projects tab still shows the pinned project area), mirroring
// needs-you-cards.spec.ts.
//
// Runs serially (playwright.config.ts pins workers:1).

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

const dbPath = path.join(os.tmpdir(), `devos-e2e-needs-you-inbox-${randomUUID()}.db`);

// A throwaway fixture project root, unique per run. Contains a single project:
//   proj/ → has a .claude/ dir → SHOULD surface as a discovery candidate.
const fixtureRoot = path.join(os.tmpdir(), `devos-e2e-needs-you-inbox-roots-${randomUUID()}`);
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

test('Needs-you inbox sorts cross-project items longest-wait-first and the Inbox badge shows the total', async ({
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

  // AC#2 (badge half): the LeftRail Inbox badge shows the total seeded blocked
  // count — 5 items: question + escalation (project 1), an interrupt item
  // (project 2), a permission request, and a foreign-session signal.
  await expect(page.getByTestId('tab-badge-inbox')).toHaveText('5');

  // Switch to the Inbox tab.
  await page.getByTestId('tab-inbox').click();
  await expect(page.getByTestId('needs-you-inbox')).toBeVisible();

  // AC#1: the seeded items must render in the KNOWN longest-wait-first order —
  // question (oldest ts) first, then escalation, then the second project's
  // bridge item, then the permission request, then the foreign-session signal
  // (newest ts, shortest wait).
  const questionItem = page.getByTestId('needs-you-item-0');
  await expect(questionItem).toBeVisible();
  await expect(questionItem).toHaveAttribute('data-kind', 'question');

  const escalationItem = page.getByTestId('needs-you-item-1');
  await expect(escalationItem).toBeVisible();
  await expect(escalationItem).toHaveAttribute('data-kind', 'escalation');

  const secondProjectItem = page.getByTestId('needs-you-item-2');
  await expect(secondProjectItem).toBeVisible();
  await expect(secondProjectItem).toHaveAttribute('data-kind', 'interrupt');
  await expect(secondProjectItem).toContainText('Second-project approval needed.');

  const permissionItem = page.getByTestId('needs-you-permission-e2e-fixture-permission-request');
  await expect(permissionItem).toBeVisible();

  const foreignItem = page.getByTestId('needs-you-foreign-e2e-fixture-foreign-session');
  await expect(foreignItem).toBeVisible();

  // Assert the relative DOM order matches the known longest-wait-first sequence.
  const items = page.locator(
    'li[data-testid^="needs-you-item-"], li[data-testid^="needs-you-permission-"], li[data-testid^="needs-you-foreign-"]',
  );
  const testIds = await items.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  expect(testIds).toEqual([
    'needs-you-item-0',
    'needs-you-item-1',
    'needs-you-item-2',
    'needs-you-permission-e2e-fixture-permission-request',
    'needs-you-foreign-e2e-fixture-foreign-session',
  ]);

  // Regression: the Projects tab area still renders.
  await page.getByTestId('tab-projects').click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`),
  ).toBeVisible();
});
