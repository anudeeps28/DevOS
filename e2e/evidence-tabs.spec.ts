// End-to-end acceptance for the work-item Detail screen's Evidence tabs:
// opening a Fleet lane's Detail auto-fires an evidence-request, and the four
// tabs (Files changed / Test results / PR summary / Audit trail) render the
// live WS-delivered snapshot.
//
// Drives the BUILT prod app (single Node process: static web/dist + /ws on the
// same origin/port), same pattern as pipeline-timeline.spec.ts. The Detail
// screen is opened through the SAME `DEVOS_E2E_FLEET_FIXTURE` seam
// (FLEET_FIXTURE_PATH / FLEET_FIXTURE_WORK_ITEM_ID = 'WI-1' in
// server/src/ws-gateway.ts) that pipeline-timeline.spec.ts uses. The
// `DEVOS_E2E_EVIDENCE_FIXTURE` seam is pinned to the SAME path + work item
// (EVIDENCE_FIXTURE_PATH === FLEET_FIXTURE_PATH, EVIDENCE_FIXTURE_WORK_ITEM_ID
// === FLEET_FIXTURE_WORK_ITEM_ID) so the Detail screen's auto-fired
// evidence-request for the opened work item gets the canned evidence reply
// through a real WS round-trip — no live SDK, no seeded repo required.
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

const dbPath = path.join(os.tmpdir(), `devos-e2e-evidence-tabs-${randomUUID()}.db`);

// MUST match FLEET_FIXTURE_PATH in server/src/ws-gateway.ts — the fixture's
// session/persona frames are pinned to this exact path, and EVIDENCE_FIXTURE_PATH
// is pinned to the SAME path so the Detail screen's auto-fired evidence-request
// gets the canned evidence reply.
const FIXTURE_PROJECT_PATH = '/tmp/devos-e2e-fleet-fixture';
const FIXTURE_PROJECT_ROOT = path.dirname(FIXTURE_PROJECT_PATH);
const FIXTURE_WORK_ITEM_ID = 'WI-1';

const ROSTER = {
  schemaVersion: 2,
  pipeline: ['builder', 'reviewer'],
  roles: {
    builder: {
      displayName: 'Builder',
      skills: ['implement', 'run-tasks'],
      agent: 'builder',
      phases: [
        { id: 'planning', displayName: 'Navigator' },
        { id: 'coding', displayName: 'Shipwright' },
        { id: 'testing', displayName: 'Lookout' },
        { id: 'shipping', displayName: 'Harbormaster' },
      ],
      model: 'claude-opus-5[1m]',
      effort: 'medium',
      producesArtifacts: [],
    },
    reviewer: {
      displayName: 'Reviewer',
      skills: ['evaluate'],
      agent: 'reviewer',
      phases: [{ id: 'reviewing', displayName: 'Warden' }],
      model: 'claude-opus-5[1m]',
      effort: 'high',
      producesArtifacts: [],
    },
  },
};

let harness: ServerHarness;

test.beforeAll(async () => {
  // Best-effort clean slate — a fixed path can carry a leftover dir from a
  // previous crashed run.
  await rm(FIXTURE_PROJECT_PATH, { recursive: true, force: true });
  await mkdir(path.join(FIXTURE_PROJECT_PATH, '.claude'), { recursive: true });
  await writeFile(
    path.join(FIXTURE_PROJECT_PATH, '.claude', 'harness-roles.json'),
    JSON.stringify(ROSTER, null, 2),
    'utf8',
  );

  harness = createServerHarness({
    extraEnv: {
      DEVOS_DB_PATH: dbPath,
      DEVOS_PROJECT_ROOTS: FIXTURE_PROJECT_ROOT,
      DEVOS_E2E_FLEET_FIXTURE: '1',
      DEVOS_E2E_EVIDENCE_FIXTURE: '1',
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

test('opening the work-item Detail renders Evidence tabs from a live WS round-trip', async ({
  page,
}) => {
  // Same narrowly-scoped drop as pipeline-timeline.spec.ts: a real (but empty)
  // session-personas response for this fixture path would erase the fixture's
  // already-delivered persona join. Every other frame — including `evidence` —
  // is fully real and untouched.
  await page.addInitScript((fixturePath: string) => {
    const OriginalWebSocket = window.WebSocket;
    class GuardedWebSocket extends OriginalWebSocket {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data === 'string') {
          try {
            const parsed: unknown = JSON.parse(data);
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              (parsed as { type?: unknown }).type === 'session-personas' &&
              (parsed as { path?: unknown }).path === fixturePath
            ) {
              return;
            }
          } catch {
            // not JSON — fall through and send as-is
          }
        }
        super.send(data);
      }
    }
    window.WebSocket = GuardedWebSocket;
  }, FIXTURE_PROJECT_PATH);

  await page.goto(harness.url);

  // Pin the real fixture project so the app requests its roster-timeline.
  await page.getByTestId('discover-refresh').click();
  await expect(page.getByTestId(`candidate-${FIXTURE_PROJECT_PATH}`)).toBeVisible();
  await page.getByTestId(`candidate-pin-${FIXTURE_PROJECT_PATH}`).click();
  await expect(
    page.locator(`[data-testid="project-item"][data-path="${FIXTURE_PROJECT_PATH}"]`),
  ).toBeVisible();

  // Switch to the Fleet tab and open the seeded work item's lane.
  await page.getByTestId('tab-fleet').click();
  const workItemLane = page.locator(
    `[data-testid="fleet-workitem"][data-workitem="${FIXTURE_WORK_ITEM_ID}"]`,
  );
  await expect(workItemLane).toBeVisible();
  await workItemLane.click();

  // The Detail screen renders for the clicked work item, and auto-fires an
  // evidence-request on mount (WorkItemDetail's useEffect).
  const detail = page.locator(`[data-testid="work-item-detail"][data-workitem="${FIXTURE_WORK_ITEM_ID}"]`);
  await expect(detail).toBeVisible();

  // Files changed tab (default) lists the canned changed files.
  await expect(detail.getByTestId('evidence-tab-files')).toBeVisible();
  const filesPanel = detail.getByTestId('evidence-panel-files');
  await expect(filesPanel).toContainText('web/src/components/EvidenceTabs.tsx');
  await expect(filesPanel).toContainText('server/src/evidence/evidence-reader.ts');

  // Test results tab shows the canned summary.
  await detail.getByTestId('evidence-tab-tests').click();
  await expect(detail.getByTestId('evidence-panel-tests')).toHaveText('12 passed, 0 failed');

  // PR summary tab shows the canned body.
  await detail.getByTestId('evidence-tab-pr').click();
  await expect(detail.getByTestId('evidence-panel-pr')).toHaveText(
    'Add Evidence tabs surfacing changed files, test results, and artifacts.',
  );

  // Audit trail lists artifacts with at least one Draft AND one Final badge.
  await detail.getByTestId('evidence-tab-audit').click();
  const auditPanel = detail.getByTestId('evidence-panel-audit');
  await expect(auditPanel.getByTestId('evidence-artifact')).toHaveCount(3);
  await expect(auditPanel.locator('[data-testid="evidence-badge"][data-state="Draft"]')).toHaveCount(1);
  await expect(auditPanel.locator('[data-testid="evidence-badge"][data-state="Final"]')).toHaveCount(2);
});
