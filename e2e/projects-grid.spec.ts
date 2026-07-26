// End-to-end acceptance (AC1) for the pinned-project CARD, driving the BUILT
// prod app (single Node process: static web/dist + /ws on the same origin/port).
//
// This proves the composed card: after discovering and pinning a project, ONE
// card container shows the mini-fleet placeholder + the next-task strip + the
// lifecycle stage badge, co-located in a single `project-item` card.
//
// The prod server is token-gated (Origin + local WS token). The page is served
// its own token via the injected `<meta name="devos-ws-token">`, so the WS
// connection succeeding AT ALL is itself the positive proof that Origin+token
// auth accepts the app's own page — no separate positive-auth assertion needed.
//
// A throwaway fixture tree is created under the OS temp dir and the server is
// pointed at it via DEVOS_PROJECT_ROOTS, so discovery only ever sees this test's
// directory (never the real ~/Programming root). The DB is likewise redirected
// to a throwaway tmp file via DEVOS_DB_PATH, so the test NEVER touches the real
// app-data database. Both the fixture tree and the tmp DB (+ its -wal/-shm
// sidecars) are removed in afterAll.
//
// Runs serially (playwright.config.ts pins workers:1).

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

// A throwaway DB path in the OS temp dir — unique per run so parallel/retried
// runs never collide, and the real app-data DB is never written.
const dbPath = path.join(os.tmpdir(), `devos-e2e-grid-${randomUUID()}.db`);

// A throwaway fixture project root, unique per run. Contains a single project:
//   proj/ → has a .claude/ dir → SHOULD surface as a discovery candidate.
const fixtureRoot = path.join(os.tmpdir(), `devos-e2e-grid-roots-${randomUUID()}`);
const projectPath = path.join(fixtureRoot, 'proj');

let harness: ServerHarness;

test.beforeAll(async () => {
  // Build the fixture tree first so discovery has something real to find.
  await mkdir(path.join(projectPath, '.claude'), { recursive: true });

  harness = createServerHarness({
    extraEnv: { DEVOS_DB_PATH: dbPath, DEVOS_PROJECT_ROOTS: fixtureRoot },
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

test('a pinned project renders one card with fleet placeholder + next-task strip + stage badge', async ({
  page,
}) => {
  await page.goto(harness.url);

  // Discover the fixture project (auto-discovers on connect, but click Refresh to
  // be deterministic) and pin the surfaced candidate.
  await page.getByTestId('discover-refresh').click();
  await expect(page.getByTestId(`candidate-${projectPath}`)).toBeVisible();
  await page.getByTestId(`candidate-pin-${projectPath}`).click();

  // Assert on ONE card container. Scoping every child assertion with
  // `card.getByTestId(...)` proves the three pieces are co-located in this single
  // card (not merely present somewhere on the page).
  const card = page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`);
  await expect(card).toBeVisible();

  // Mini-fleet placeholder (static stub).
  await expect(card.getByTestId(`fleet-placeholder-${projectPath}`)).toBeVisible();
  // Next-task strip (tracker state).
  await expect(card.getByTestId(`tracker-state-${projectPath}`)).toBeVisible();
  // Lifecycle stage badge.
  await expect(card.getByTestId(`lifecycle-state-${projectPath}`)).toBeVisible();
});
