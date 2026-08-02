// End-to-end acceptance for the work-item Detail screen's pipeline timeline:
// clicking a Fleet lane opens the Detail screen with the ordered stage list,
// the current stage highlighted, and the rework-loop badge; the back control
// returns to the Fleet tab.
//
// Drives the BUILT prod app (single Node process: static web/dist + /ws on the
// same origin/port), same pattern as fleet.spec.ts. The server's
// DEVOS_E2E_FLEET_FIXTURE fixture seam seeds a deterministic canned fleet
// (builder running at phase "coding", reviewer at "reviewing") through the
// real WS frames on every new client connection — no live SDK needed. See
// `sendFleetFixture` in server/src/ws-gateway.ts: the fixture's work item is
// pinned to a FIXED path, `/tmp/devos-e2e-fleet-fixture` (FLEET_FIXTURE_PATH).
//
// The pipeline-timeline's stage order + persona names come from the roster at
// `<projectPath>/.claude/harness-roles.json` (readRoster), which the app only
// requests for a currently PINNED project. So this spec creates a real,
// discoverable + pinnable project tree AT that exact fixed path, seeded with
// a real roster file — this is what makes the Detail screen's ordered stage
// list and current-stage highlight real, WS-driven state rather than faked
// DOM. The roster mirrors this repo's own `.claude/harness-roles.json`
// (SPEC §3.1): builder → planning/Navigator, coding/Shipwright,
// testing/Lookout, shipping/Harbormaster; reviewer → reviewing/Warden.
//
// The fixture never seeds a Bridge run for this path, so no `bridge-state`
// frame arrives and `reworkCount` falls back to 0 — the spec asserts the loop
// number that actually results ("loop 0 of 3") rather than faking a rework.
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

const dbPath = path.join(os.tmpdir(), `devos-e2e-pipeline-timeline-${randomUUID()}.db`);

// MUST match FLEET_FIXTURE_PATH in server/src/ws-gateway.ts — the fixture's
// session/persona frames are pinned to this exact path.
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

test('Fleet lane opens the work-item Detail screen with the ordered, highlighted pipeline timeline', async ({
  page,
}) => {
  // The client auto-refreshes `session-personas` for every currently-pinned
  // project on connect/pin (useProjects.ts). For a REAL pinned project that
  // has no REAL owned session in the server's in-memory session manager (the
  // fixture's builder/reviewer sessions are injected as raw WS frames, not
  // real owned sessions — by design, so this e2e needs no live SDK), that
  // real-but-empty response would immediately overwrite the fixture's
  // already-delivered persona join with an empty list, erasing the
  // current-stage highlight this spec asserts. Drop only that one, narrowly-
  // scoped outbound request type for the fixture path so the fixture's own
  // (real, WS-delivered) session-personas frame is the one the app renders —
  // every other frame (roster-timeline, session-state, bridge-state) is
  // fully real and untouched.
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

  // The Detail screen renders for the clicked work item.
  const detail = page.locator(`[data-testid="work-item-detail"][data-workitem="${FIXTURE_WORK_ITEM_ID}"]`);
  await expect(detail).toBeVisible();

  // Ordered stage list, per SPEC §6: builder non-shipping, reviewer, builder shipping.
  const stages = detail.getByTestId('pipeline-stage');
  await expect(stages).toHaveCount(5);
  await expect(stages.nth(0)).toContainText('Navigator');
  await expect(stages.nth(1)).toContainText('Shipwright');
  await expect(stages.nth(2)).toContainText('Lookout');
  await expect(stages.nth(3)).toContainText('Warden');
  await expect(stages.nth(4)).toContainText('Harbormaster');

  // Only the builder's current phase ("coding" → Shipwright) is highlighted.
  const currentStage = detail.locator('[data-testid="pipeline-stage"][data-current="true"]');
  await expect(currentStage).toHaveCount(1);
  await expect(currentStage).toHaveAttribute('data-phase', 'coding');
  await expect(currentStage).toContainText('Shipwright');

  // No Bridge run was seeded for this path, so reworkCount falls back to 0 —
  // assert the loop number that actually results, not a faked rework.
  await expect(detail.getByTestId('pipeline-loop')).toHaveText('loop 0 of 3');

  // Back returns to the Fleet tab shell.
  await detail.getByTestId('detail-back').click();
  await expect(detail).not.toBeVisible();
  await expect(workItemLane).toBeVisible();
});
