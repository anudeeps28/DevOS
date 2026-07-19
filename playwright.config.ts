import { defineConfig, devices } from '@playwright/test';

// No managed `webServer`: the reconnect spec spawns/kills/respawns its own prod
// server child process (see e2e/helpers/server-harness.ts) so it can simulate a
// drop. baseURL points at the single-process prod bind (127.0.0.1:8787).
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:8787',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
