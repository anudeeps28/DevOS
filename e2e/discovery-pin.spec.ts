// End-to-end acceptance for the project discovery → pin flow, driving the BUILT
// prod app (single Node process: static web/dist + /ws on the same origin/port).
//
// This exercises the full discovery stack in one shot:
//   browser → WS → gateway → scanner (filesystem) → candidate snapshot → DOM,
//   then: click Pin → Registry → SQLite → broadcast registry snapshot → grid.
//
// A throwaway fixture tree is created under the OS temp dir and the server is
// pointed at it via DEVOS_PROJECT_ROOTS, so discovery only ever sees this test's
// directories (never the real ~/Programming root). The DB is likewise redirected
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
const dbPath = path.join(os.tmpdir(), `devos-e2e-${randomUUID()}.db`);

// A throwaway fixture project root, unique per run. Contains:
//   alpha/  → has a .claude/ dir  → SHOULD surface as a discovery candidate
//   beta/   → no  .claude/ dir    → must NOT surface as a candidate
const fixtureRoot = path.join(os.tmpdir(), `devos-e2e-roots-${randomUUID()}`);
const alphaPath = path.join(fixtureRoot, 'alpha');
const betaPath = path.join(fixtureRoot, 'beta');

let harness: ServerHarness;

test.beforeAll(async () => {
  // Build the fixture tree first so discovery has something real to find.
  await mkdir(path.join(alphaPath, '.claude'), { recursive: true });
  await mkdir(betaPath, { recursive: true });

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

test('discovers a candidate, pins it, and it lands in the projects grid', async ({ page }) => {
  await page.goto(harness.url);

  // AC3: nothing pinned yet → the empty state is shown.
  await expect(page.getByTestId('discovery-empty')).toBeVisible();

  // AC1: the app auto-discovers on connect, but click Refresh to be deterministic.
  // `alpha` (has .claude/) must surface as a candidate; `beta` (no .claude/) must not.
  await page.getByTestId('discover-refresh').click();
  await expect(page.getByTestId(`candidate-${alphaPath}`)).toBeVisible();
  await expect(page.getByTestId(`candidate-${betaPath}`)).toHaveCount(0);

  // AC2: pin the discovered candidate — it round-trips into the projects grid and
  // the empty state disappears.
  await page.getByTestId(`candidate-pin-${alphaPath}`).click();
  const item = page.locator(`[data-testid="project-item"][data-path="${alphaPath}"]`);
  await expect(item).toBeVisible();
  await expect(page.getByTestId('discovery-empty')).toHaveCount(0);
});
