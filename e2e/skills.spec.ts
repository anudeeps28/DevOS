// End-to-end acceptance (AC5) for the Skills panel, driving the BUILT prod app
// (single Node process: static web/dist + /ws on the same origin/port), same
// pattern as projects-grid.spec.ts.
//
// A throwaway fixture tree is created under the OS temp dir and the server is
// pointed at it via DEVOS_PROJECT_ROOTS, so discovery only ever sees this test's
// directory (never the real ~/Programming root). The fixture project's
// `.claude/skills/` contains two skills — `alpha` (listed in the manifest's
// `installedFiles`, so it classifies 'org') and `beta` (not listed, so it
// classifies 'local') — each with a `---`-fenced SKILL.md frontmatter block.
// The DB is likewise redirected to a throwaway tmp file via DEVOS_DB_PATH, so
// the test NEVER touches the real app-data database. Both the fixture tree and
// the tmp DB (+ its -wal/-shm sidecars) are removed in afterAll.
//
// Runs serially (playwright.config.ts pins workers:1).

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

// A throwaway DB path in the OS temp dir — unique per run so parallel/retried
// runs never collide, and the real app-data DB is never written.
const dbPath = path.join(os.tmpdir(), `devos-e2e-skills-${randomUUID()}.db`);

// A throwaway fixture project root, unique per run. Contains a single project:
//   proj/ → has a .claude/ dir → SHOULD surface as a discovery candidate.
const fixtureRoot = path.join(os.tmpdir(), `devos-e2e-skills-roots-${randomUUID()}`);
const projectPath = path.join(fixtureRoot, 'proj');
const claudeDir = path.join(projectPath, '.claude');
const skillsDir = path.join(claudeDir, 'skills');

let harness: ServerHarness;

test.beforeAll(async () => {
  // Build the fixture tree first so discovery has something real to find.
  await mkdir(claudeDir, { recursive: true });

  // org skill — listed in the manifest's installedFiles.
  const alphaDir = path.join(skillsDir, 'alpha');
  await mkdir(alphaDir, { recursive: true });
  await writeFile(
    path.join(alphaDir, 'SKILL.md'),
    ['---', 'name: alpha', 'description: The alpha skill (org).', '---', '', '# Alpha', ''].join('\n'),
    'utf8',
  );

  // local skill — NOT listed in the manifest's installedFiles.
  const betaDir = path.join(skillsDir, 'beta');
  await mkdir(betaDir, { recursive: true });
  await writeFile(
    path.join(betaDir, 'SKILL.md'),
    ['---', 'name: beta', 'description: The beta skill (local).', '---', '', '# Beta', ''].join('\n'),
    'utf8',
  );

  await writeFile(
    path.join(claudeDir, '.harness-manifest.json'),
    JSON.stringify({ installedFiles: ['skills/alpha/SKILL.md'] }, null, 2),
    'utf8',
  );

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

test('Skills tab renders org and local skill groups with descriptions', async ({ page }) => {
  await page.goto(harness.url);

  // Discover the fixture project (auto-discovers on connect, but click Refresh to
  // be deterministic) and pin the surfaced candidate.
  await page.getByTestId('discover-refresh').click();
  await expect(page.getByTestId(`candidate-${projectPath}`)).toBeVisible();
  await page.getByTestId(`candidate-pin-${projectPath}`).click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${projectPath}"]`),
  ).toBeVisible();

  // Switch to the Skills tab.
  await page.getByTestId('tab-skills').click();
  await expect(page.getByTestId('skills-panel')).toBeVisible();

  // AC5: the org group shows `alpha` with its description, and the local group
  // shows `beta` with its description.
  const orgGroup = page.getByTestId('skills-group-org');
  await expect(orgGroup).toBeVisible();
  const alphaRow = orgGroup.getByTestId('skill-alpha');
  await expect(alphaRow).toBeVisible();
  await expect(alphaRow).toContainText('alpha');
  await expect(alphaRow).toContainText('The alpha skill (org).');

  const localGroup = page.getByTestId('skills-group-local');
  await expect(localGroup).toBeVisible();
  const betaRow = localGroup.getByTestId('skill-beta');
  await expect(betaRow).toBeVisible();
  await expect(betaRow).toContainText('beta');
  await expect(betaRow).toContainText('The beta skill (local).');
});
