// End-to-end acceptance for "Kick off next stage": clicking a pinned project's
// stage launcher button starts an owned session for the project's current
// lifecycle stage, and that session surfaces in the Team room — WITHOUT any
// set-stage control anywhere in the DOM (the advance is emergent, driven only
// by the artifacts the next session produces, never by a client-side stage
// write).
//
// Drives the BUILT prod app (single Node process: static web/dist + /ws on the
// same origin/port), same pattern as assign-work.spec.ts. The server's `query`
// engine is swapped for the deterministic DEVOS_E2E_FAKE_QUERY seam
// (server/src/session/e2e-fake-query.ts) so no live SDK is needed.
//
// The fixture project tree carries a single `grill-summary.md` marker at its
// root — the simplest artifact the server's lifecycle-signals reader
// (server/src/lifecycle/lifecycle-reader.ts) detects for `hasDecideDocs`,
// which resolveStage (web/src/lib/lifecycle.ts) composes into the `Decide`
// stage. Decide's next-skill label is `/architect` (web/src/lib/lifecycle.ts
// NEXT_STAGE_ACTIONS / server/src/session/stage-actions.ts).
//
// A throwaway DB is used (redirected via DEVOS_DB_PATH), so the test NEVER
// touches the real app-data database. Runs serially (playwright.config.ts
// pins workers:1).

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

const dbPath = path.join(os.tmpdir(), `devos-e2e-kick-off-next-stage-${randomUUID()}.db`);

const FIXTURE_PROJECT_PATH = path.join(os.tmpdir(), 'devos-e2e-kick-off-next-stage-fixture');
const FIXTURE_PROJECT_ROOT = path.dirname(FIXTURE_PROJECT_PATH);

let harness: ServerHarness;

test.beforeAll(async () => {
  // Best-effort clean slate — a fixed path can carry a leftover dir from a
  // previous crashed run.
  await rm(FIXTURE_PROJECT_PATH, { recursive: true, force: true });
  // Discovery only surfaces a directory as a candidate when it carries a
  // `.claude/` dir (server/src/discovery/scanner.ts hasClaudeInstall).
  await mkdir(path.join(FIXTURE_PROJECT_PATH, '.claude'), { recursive: true });
  // The simplest artifact resolveStage's server-side signal reader detects for
  // `hasDecideDocs` — bumps the fixture straight to the Decide stage.
  await writeFile(path.join(FIXTURE_PROJECT_PATH, 'grill-summary.md'), '# Grill summary\n', 'utf8');

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

test('Kick-off-next-stage launches a session into the Team room, with no set-stage control and no badge mutation', async ({
  page,
}) => {
  await page.goto(harness.url);

  // Pin the real fixture project so the app requests its lifecycle-signals.
  await page.getByTestId('discover-refresh').click();
  await expect(page.getByTestId(`candidate-${FIXTURE_PROJECT_PATH}`)).toBeVisible();
  await page.getByTestId(`candidate-pin-${FIXTURE_PROJECT_PATH}`).click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${FIXTURE_PROJECT_PATH}"]`),
  ).toBeVisible();

  // AC5 — the launcher is present, labeled with the next skill, and there is
  // NO set-stage/stage-picker control anywhere in the DOM (emergent advance
  // only — never a client-side stage write).
  const badge = page.getByTestId(`lifecycle-state-${FIXTURE_PROJECT_PATH}`);
  await expect(badge).toHaveAttribute('data-stage', 'Decide');

  const launcher = page.getByTestId(`kick-off-${FIXTURE_PROJECT_PATH}`);
  await expect(launcher).toBeVisible();
  await expect(launcher).toContainText('/architect');
  await expect(launcher).toHaveAttribute('data-active', 'true');

  await expect(page.locator('[data-testid*="set-stage"]')).toHaveCount(0);
  await expect(page.locator('[data-testid*="stage-picker"]')).toHaveCount(0);

  // AC4 — read the badge's stage BEFORE clicking, then click the launcher.
  const stageBeforeClick = await badge.getAttribute('data-stage');
  expect(stageBeforeClick).toBe('Decide');

  await launcher.click();

  // The Team room surfaces a running session for the fixture project.
  const teamRoom = page.getByTestId('team-room');
  const session = teamRoom.locator('[data-testid^="team-room-session-"]');
  await expect(session).toBeVisible({ timeout: 10_000 });
  await expect(session).toHaveAttribute('data-session-id', /.+/);
  await expect(teamRoom).toContainText(FIXTURE_PROJECT_PATH);

  // AC4 (emergent advance) — the badge's `data-stage` is UNCHANGED immediately
  // after launch: the stage advances only when the next session's OWN
  // artifacts are later detected by the signals reader, never via a
  // client-driven set-stage write.
  await expect(badge).toHaveAttribute('data-stage', 'Decide');
});
