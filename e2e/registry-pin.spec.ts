// End-to-end acceptance for the project pin/unpin registry round-trip, driving
// the BUILT prod app (single Node process: static web/dist + /ws on the same
// origin/port).
//
// This exercises the full stack in one shot:
//   browser → WS → gateway → Registry → SQLite → broadcast snapshot → DOM.
//
// The DB is redirected to a throwaway tmp file via DEVOS_DB_PATH injected into
// the spawned server child (see helpers/server-harness.ts), so the test NEVER
// touches the real app-data database (AC4). The tmp DB (+ its -wal/-shm
// sidecars) is removed in afterAll.
//
// Runs serially (playwright.config.ts pins workers:1).

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

// A throwaway DB path in the OS temp dir — unique per run so parallel/retried
// runs never collide, and the real app-data DB is never written.
const dbPath = path.join(os.tmpdir(), `devos-e2e-${randomUUID()}.db`);

let harness: ServerHarness;

test.beforeAll(async () => {
  harness = createServerHarness({ extraEnv: { DEVOS_DB_PATH: dbPath } });
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
});

test('pin then unpin round-trips through the full stack to the DOM', async ({ page }) => {
  // Use a real absolute directory so the path is a plausible project root.
  const projectPath = os.tmpdir();

  await page.goto(harness.url);

  // Pin: type an absolute path and submit.
  await page.getByTestId('pin-path-input').fill(projectPath);
  await page.getByTestId('pin-submit').click();

  // The round-trip must surface the pinned project back in the DOM. Match by the
  // data-path attribute the component stamps onto each list item.
  const item = page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`);
  await expect(item).toBeVisible();

  // Unpin: click the item's dedicated unpin button; the item must disappear once
  // the removal round-trips back as a fresh snapshot.
  await page.getByTestId(`unpin-${projectPath}`).click();
  await expect(item).toHaveCount(0);
});
