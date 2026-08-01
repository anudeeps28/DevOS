// End-to-end acceptance for the status-bar cost/usage figure (AC3).
//
// Drives the BUILT prod app (single Node process: static web/dist + /ws on the same
// origin/port), same pattern as fleet.spec.ts. The server's DEVOS_E2E_COST_FIXTURE
// seam emits a single deterministic non-zero `cost-usage` frame on every new client
// connection (see the DEVOS_E2E_COST_FIXTURE block in server/src/ws-gateway.ts) —
// no live SDK or real ledger writes needed.
//
// A throwaway fixture tree + DB are still used, mirroring fleet.spec.ts: the DB is
// redirected to a throwaway tmp file so the test NEVER touches the real app-data
// database.
//
// Runs serially (playwright.config.ts pins workers:1).

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

const dbPath = path.join(os.tmpdir(), `devos-e2e-cost-${randomUUID()}.db`);

// A throwaway fixture project root, unique per run — the harness itself doesn't need
// a real project for this spec, but DEVOS_PROJECT_ROOTS must point somewhere real.
const fixtureRoot = path.join(os.tmpdir(), `devos-e2e-cost-roots-${randomUUID()}`);

let harness: ServerHarness;

test.beforeAll(async () => {
  await mkdir(fixtureRoot, { recursive: true });

  harness = createServerHarness({
    extraEnv: {
      DEVOS_DB_PATH: dbPath,
      DEVOS_PROJECT_ROOTS: fixtureRoot,
      DEVOS_E2E_COST_FIXTURE: '1',
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

test('status bar shows and updates the cost-today figure, labelled "Usage today"', async ({ page }) => {
  await page.goto(harness.url);

  await expect(page.getByText('Usage today')).toBeVisible();
  await expect(page.getByTestId('cost-today')).toHaveText('$1.23');
});
