// Test harness that drives the BUILT prod server as a child process so an e2e
// spec can simulate a WebSocket drop (kill) and recovery (respawn) without a
// page reload.
//
// The prod server (`node server/dist/index.js`) serves the static web/dist
// bundle over HTTP and accepts the /ws upgrade on the same origin/port. We run
// it on a non-default port (8850) to avoid clashing with a real dev/prod server
// that may already be bound to 8787.
//
// Design notes:
//  - No mutation of shared state across restarts: start() always spawns a fresh
//    child and resolves once it is confirmed listening.
//  - Clean teardown: stop() kills the child and awaits its 'exit'; dispose() is
//    idempotent and safe to call from a finally / afterEach even after failures.

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// e2e/helpers/server-harness.ts -> repo root is two directories up.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'dist', 'index.js');

export const HARNESS_HOST = '127.0.0.1';

const READY_TIMEOUT_MS = 20_000;
const READY_POLL_INTERVAL_MS = 150;
const STOP_TIMEOUT_MS = 5_000;
// The reconnect test respawns on the SAME port (the page was loaded from it), so
// a fresh child can race the just-killed one for the port. Retry the spawn a few
// times when the OS still reports the port in use.
const MAX_SPAWN_ATTEMPTS = 6;
const SPAWN_RETRY_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Ask the OS for a currently-free loopback TCP port (bind :0, read it, release). */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HARNESS_HOST, () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** True if a child's early-exit was caused by the bind port still being in use. */
function isAddrInUse(logs: readonly string[]): boolean {
  const text = logs.join('');
  return text.includes('EADDRINUSE') || text.includes('already in use');
}

interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Controls one prod-server child process for an e2e spec. */
export interface ServerHarness {
  readonly url: string;
  /** Spawn a fresh prod server and resolve once it is listening. */
  readonly start: () => Promise<void>;
  /** Kill the running child and await its exit. No-op if not running. */
  readonly stop: () => Promise<void>;
  /** Recent stdout+stderr lines from the current/last child (for optional log assertions). */
  readonly getLogs: () => readonly string[];
}

export function createServerHarness(fixedPort?: number): ServerHarness {
  let child: ChildProcess | null = null;
  let logs: string[] = [];
  // Chosen once on first start() and reused across restarts: the reconnect test
  // reloads the page from this URL, so the port must stay stable for the client's
  // reconnect loop to find the respawned server.
  let port: number | undefined = fixedPort;
  let url = port === undefined ? '' : `http://${HARNESS_HOST}:${port}`;

  // One spawn+ready attempt. Resolves 'ready', or 'addr-in-use' if the child died
  // because the port was still held (retryable), or throws for any other failure.
  const spawnOnce = async (): Promise<'ready' | 'addr-in-use'> => {
    logs = [];
    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: HARNESS_HOST,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;

    const record = (chunk: Buffer): void => {
      logs.push(chunk.toString());
    };
    proc.stdout?.on('data', record);
    proc.stderr?.on('data', record);

    // Holder object rather than a bare `let`: property reads keep the declared
    // union type, so the guard below narrows correctly (the assignment happens in
    // a callback that control-flow analysis can't otherwise account for).
    const exitState: { value: ExitInfo | null } = { value: null };
    proc.once('exit', (code, signal) => {
      if (child === proc) child = null;
      exitState.value = { code, signal };
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const exit = exitState.value;
      if (exit !== null) {
        if (isAddrInUse(logs)) return 'addr-in-use';
        throw new Error(
          `Prod server exited early (code=${String(exit.code)}, signal=${String(exit.signal)}). ` +
            `Logs:\n${logs.join('')}`,
        );
      }
      try {
        const res = await fetch(url, { method: 'GET' });
        if (res.status === 200) {
          await res.text();
          return 'ready';
        }
      } catch {
        // not up yet
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Prod server at ${url} did not become ready within ${READY_TIMEOUT_MS}ms. ` +
            `Did you run \`npm run build\` first (server/dist + web/dist)?`,
        );
      }
      await delay(READY_POLL_INTERVAL_MS);
    }
  };

  const start = async (): Promise<void> => {
    if (child !== null) {
      throw new Error('ServerHarness.start() called while a child is still running — call stop() first.');
    }
    if (port === undefined) {
      port = await getFreePort();
      url = `http://${HARNESS_HOST}:${port}`;
    }

    for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt += 1) {
      let outcome: 'ready' | 'addr-in-use';
      try {
        outcome = await spawnOnce();
      } catch (err) {
        await stop(); // never leak the child on a failed attempt
        throw err;
      }
      if (outcome === 'ready') return;
      // Port still held by the just-killed child — wait for release and retry.
      if (attempt < MAX_SPAWN_ATTEMPTS) {
        await delay(SPAWN_RETRY_DELAY_MS);
      }
    }
    throw new Error(
      `Prod server could not bind ${url} after ${MAX_SPAWN_ATTEMPTS} attempts (port stayed in use).`,
    );
  };

  const stop = async (): Promise<void> => {
    const proc = child;
    if (proc === null) return;
    child = null;

    if (proc.exitCode !== null || proc.signalCode !== null) {
      return; // already exited
    }

    const exited = new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
    });

    proc.kill('SIGTERM');

    const timer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS);
    });

    const outcome = await Promise.race([exited.then(() => 'exited' as const), timer]);
    if (outcome === 'timeout') {
      proc.kill('SIGKILL');
      await exited;
    }
  };

  return {
    // Getter: the URL is only known after start() resolves the free port.
    get url(): string {
      if (url === '') throw new Error('ServerHarness.url read before start() — call start() first.');
      return url;
    },
    start,
    stop,
    getLogs: () => logs,
  };
}
