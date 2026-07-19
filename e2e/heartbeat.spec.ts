// End-to-end acceptance for the live-heartbeat foundation, driving the BUILT
// prod app (single Node process: static web/dist + /ws on the same origin/port).
//
// The spec owns its server child process (see helpers/server-harness.ts) so it
// can kill the server mid-test and prove the browser auto-reconnects WITHOUT a
// page reload.
//
// Acceptance criteria covered (test-strategy.md):
//  - Test A → criterion 1: live heartbeat renders and advances ≥2×.
//  - Test B → criterion 3: connection lifecycle visible + auto-reconnect recovers.

import { test, expect, type Page } from '@playwright/test';
import { createServerHarness, type ServerHarness } from './helpers/server-harness';

const SAMPLE_INTERVAL_MS = 1_100; // ≥1s apart; server cadence is 1000ms.

let harness: ServerHarness;

test.afterEach(async () => {
  // Idempotent teardown — never leave an orphan server child running.
  if (harness !== undefined) {
    await harness.stop();
  }
});

/** Current heartbeat seq shown in the DOM, or -1 before the first beat ('—'). */
async function readSeq(page: Page): Promise<number> {
  const text = await page.getByTestId('heartbeat-seq').textContent();
  const value = Number.parseInt((text ?? '').trim(), 10);
  return Number.isNaN(value) ? -1 : value;
}

/** Wait until the DOM has rendered at least one real heartbeat seq (≥1). */
async function waitForFirstBeat(page: Page): Promise<void> {
  await expect
    .poll(() => readSeq(page), { timeout: 15_000, message: 'heartbeat never rendered a numeric seq' })
    .toBeGreaterThanOrEqual(1);
}

const statusLocator = (page: Page) => page.getByTestId('connection-status');

test('Test A — live heartbeat renders and advances at least twice', async ({ page }) => {
  harness = createServerHarness();
  await harness.start();

  await page.goto(harness.url);

  // Criterion 3 (positive half): the connection indicator reaches "connected".
  await expect(statusLocator(page)).toHaveAttribute('data-status', 'connected', { timeout: 15_000 });

  await waitForFirstBeat(page);

  // Capture 3 samples ≥1s apart and assert the value strictly increases across
  // them — two advances prove the stream is live, not a static render.
  const s1 = await readSeq(page);
  await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  const s2 = await readSeq(page);
  await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  const s3 = await readSeq(page);

  expect(s2, `seq should advance: ${s1} -> ${s2}`).toBeGreaterThan(s1);
  expect(s3, `seq should advance: ${s2} -> ${s3}`).toBeGreaterThan(s2);
});

test('Test B — connection indicator recovers via auto-reconnect after a server drop', async ({
  page,
}) => {
  harness = createServerHarness();
  await harness.start();

  await page.goto(harness.url);
  await expect(statusLocator(page)).toHaveAttribute('data-status', 'connected', { timeout: 15_000 });
  await waitForFirstBeat(page);

  // Drop the server: the WS closes and the indicator must flip off "connected".
  await harness.stop();
  await expect(statusLocator(page)).not.toHaveAttribute('data-status', 'connected', {
    timeout: 15_000,
  });

  // Restart the server WITHOUT reloading the page — the client's own reconnect
  // loop must re-establish the WS and the indicator must recover to "connected".
  await harness.start();
  await expect(statusLocator(page)).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });

  // The restarted server begins a fresh heartbeat stream at seq 1, so we assert
  // the NEW stream advances (two increasing samples ≥1s apart) rather than
  // comparing against the — now stale — pre-drop value.
  const staleValue = await readSeq(page);
  await expect
    .poll(() => readSeq(page), {
      timeout: 15_000,
      message: 'no fresh heartbeat arrived after reconnect',
    })
    .not.toBe(staleValue);

  const a = await readSeq(page);
  await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  const b = await readSeq(page);
  expect(b, `heartbeat should keep advancing after reconnect: ${a} -> ${b}`).toBeGreaterThan(a);
});
