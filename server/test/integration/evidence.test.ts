// Integration test — evidence read round-trip over the live WS transport.
//
// Boots the REAL server in-process on a free port (PORT=0) with an explicit,
// per-test on-disk SQLite file AND a per-test tmp git fixture, opens a real
// `ws` client, sends `{type:'evidence-request', path, workItemId}`, awaits the
// `evidence` frame, and asserts:
//   - the changed file(s) come from a REAL `git diff` against the fixture repo
//   - the test-results summary comes from the seeded `regression.log`
//   - the PR summary comes from the seeded `pr-body.md`
//   - the artifacts are badged Final (the seeded `phase.md` is `phase: shipping`)
//   - an UNPINNED path yields no `evidence` reply (fails closed)
//   - an unsafe workItemId (e.g. `../x`) is rejected at the ws-protocol boundary
//     (the frame fails to parse, so it is never dispatched — no reply)
//
// Git fixtures run through execFile with an inline headless identity and a
// neutered global/system config — fully offline, no ambient git identity, no
// network. Mirrors server/test/integration/git-state.test.ts's bootstrap.
//
// Isolation: every test uses its OWN tmp fixtures + tmp DB file (never the real
// app-data DB). afterEach removes the fixture trees and the .db/.db-wal/.db-shm
// sidecars.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import type { EvidenceData } from '../../src/ws-protocol.js';

const execFileAsync = promisify(execFile);

// Inline identity + deterministic config so no global/system git identity is
// required and commits never wait on a signing key or a network.
const GIT_IDENTITY_ARGS = [
  '-c',
  'user.email=t@t.t',
  '-c',
  'user.name=Test',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
];

// Fully isolate from the developer's own git config (aliases, hooksPath, etc.).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** Run git in `cwd` with the isolated identity/env; returns trimmed stdout. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_IDENTITY_ARGS, ...args], {
    cwd,
    env: GIT_ENV,
  });
  return stdout.trim();
}

/**
 * Init a repo at `dir` with one commit on `main`, then land a SECOND commit on
 * a `work` branch that modifies the tracked file — so `git diff main...HEAD`
 * (readChangedFiles' diff base) has a real, non-empty base to compare against.
 */
async function initRepoWithDiffBase(dir: string): Promise<void> {
  await git(dir, ['init']);
  await fs.writeFile(join(dir, 'file.txt'), 'v1\n');
  await git(dir, ['add', 'file.txt']);
  await git(dir, ['commit', '-m', 'initial']);
  await git(dir, ['checkout', '-b', 'work']);
  await fs.writeFile(join(dir, 'file.txt'), 'v2\n');
  await git(dir, ['commit', '-am', 'modify file']);
}

const WORK_ITEM_ID = 'WI-EVIDENCE';
const REGRESSION_LOG = 'unit: 10 passed\nintegration: 4 passed\n';
const PR_BODY = 'Evidence WS integration round-trip.';

/** Seed `tasks/stories/<workItemId>/` with the artifacts readEvidence looks for. */
async function seedStory(projectPath: string, workItemId: string): Promise<void> {
  const storyDir = join(projectPath, 'tasks', 'stories', workItemId);
  await fs.mkdir(storyDir, { recursive: true });
  await fs.writeFile(join(storyDir, 'brief.md'), '# Brief\n');
  await fs.writeFile(join(storyDir, 'plan.md'), '# Plan\n');
  await fs.writeFile(join(storyDir, 'pr-body.md'), PR_BODY);
  await fs.writeFile(join(storyDir, 'regression.log'), REGRESSION_LOG);
  await fs.writeFile(join(storyDir, 'phase.md'), 'schemaVersion: 1\nphase: shipping\n');
}

interface EvidenceFrame {
  readonly type: 'evidence';
  readonly path: string;
  readonly workItemId: string;
  readonly evidence: EvidenceData;
}

function isEvidenceFrame(value: unknown): value is EvidenceFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'evidence' &&
    typeof frame.path === 'string' &&
    typeof frame.workItemId === 'string' &&
    typeof frame.evidence === 'object' &&
    frame.evidence !== null
  );
}

interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForEvidence: (
    predicate: (frame: EvidenceFrame) => boolean,
    timeoutMs: number,
  ) => Promise<EvidenceFrame>;
  readonly evidenceFrames: () => readonly EvidenceFrame[];
  readonly close: () => void;
}

interface Waiter<T> {
  readonly predicate: (frame: T) => boolean;
  readonly resolve: (frame: T) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function openClient(url: string, openTimeoutMs = 3000): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let evidenceWaiters: Array<Waiter<EvidenceFrame>> = [];
    const evidenceFrames: EvidenceFrame[] = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    const failAll = (error: Error): void => {
      const pending = evidenceWaiters;
      evidenceWaiters = [];
      for (const waiter of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    };

    socket.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!opened) {
        clearTimeout(openTimer);
        reject(error);
        return;
      }
      failAll(error);
    });

    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (isEvidenceFrame(parsed)) {
        const frame = parsed;
        evidenceFrames.push(frame);
        const stillWaiting: Array<Waiter<EvidenceFrame>> = [];
        for (const waiter of evidenceWaiters) {
          if (waiter.predicate(frame)) {
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          } else {
            stillWaiting.push(waiter);
          }
        }
        evidenceWaiters = stillWaiting;
        return;
      }
      // Heartbeat / registry / anything else — ignore.
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send: (message: unknown) => socket.send(JSON.stringify(message)),
        waitForEvidence: (predicate, timeoutMs) =>
          new Promise<EvidenceFrame>((res, rej) => {
            const timer = setTimeout(() => {
              evidenceWaiters = evidenceWaiters.filter((w) => w.timer !== timer);
              rej(new Error(`Timed out after ${timeoutMs}ms waiting for a matching evidence frame`));
            }, timeoutMs);
            evidenceWaiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        evidenceFrames: () => [...evidenceFrames],
        close: () => {
          socket.removeAllListeners();
          socket.close();
        },
      });
    });
  });
}

// Per-test resources, torn down in afterEach.
const activeClients: TestClient[] = [];
const activeStops: Array<() => Promise<void>> = [];
const tmpDbPaths: string[] = [];
const tmpRoots: string[] = [];

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-evidence-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

/** Create a tracked tmp root directory (recursively removed in afterEach). */
async function makeTmpRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `devos-evidence-${prefix}-${randomUUID()}`);
  tmpRoots.push(root);
  await fs.mkdir(root, { recursive: true });
  return root;
}

interface RunningServer {
  readonly instance: import('../../src/index.js').DevOsServer;
  readonly address: AddressInfo;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function startServer(dbPath: string): Promise<RunningServer> {
  // No project roots: evidence reads target explicit absolute paths, so
  // discovery never runs and never interferes with the frames under test.
  const instance = createServer({ port: 0, dbPath, projectRoots: [] });
  const address = await instance.start();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await instance.stop();
  };
  activeStops.push(stop);
  return { instance, address, url: `ws://127.0.0.1:${address.port}${WS_PATH}`, stop };
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) {
    client.close();
  }
  // Guarded stop — safe even if a test already stopped its server.
  for (const stop of activeStops.splice(0)) {
    await stop().catch(() => undefined);
  }
  for (const root of tmpRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const path of tmpDbPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

async function connect(url: string): Promise<TestClient> {
  const client = await openClient(url);
  activeClients.push(client);
  return client;
}

describe('evidence read round-trip over the live WS transport', () => {
  it('a pinned project + work item returns the live changed files, test summary, PR body, and Final artifacts', async () => {
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const projectPath = await makeTmpRoot('live');
    await initRepoWithDiffBase(projectPath);
    await seedStory(projectPath, WORK_ITEM_ID);

    // Access control: only reads against PINNED projects are served.
    server.instance.registry.pin(projectPath);

    const client = await connect(server.url);
    const framePromise = client.waitForEvidence(
      (f) => f.path === projectPath && f.workItemId === WORK_ITEM_ID,
      5000,
    );
    client.send({ type: 'evidence-request', path: projectPath, workItemId: WORK_ITEM_ID });
    const frame = await framePromise;

    expect(frame.evidence.filesChanged.map((f) => f.path)).toContain('file.txt');
    expect(frame.evidence.testResults.summary).toBe(REGRESSION_LOG.trim());
    expect(frame.evidence.prSummary).toBe(PR_BODY);
    expect(frame.evidence.artifacts.length).toBeGreaterThan(0);
    for (const artifact of frame.evidence.artifacts) {
      expect(artifact.state).toBe('Final');
    }
    expect(frame.evidence.artifacts.map((a) => a.name)).toEqual(
      expect.arrayContaining(['brief.md', 'plan.md', 'pr-body.md', 'regression.log']),
    );

    await server.stop();
  }, 15000);

  it('sends no evidence frame when the requested path is NOT pinned (fails closed)', async () => {
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const projectPath = await makeTmpRoot('unpinned');
    await initRepoWithDiffBase(projectPath);
    await seedStory(projectPath, WORK_ITEM_ID);
    // Deliberately NOT pinned.

    const client = await connect(server.url);
    client.send({ type: 'evidence-request', path: projectPath, workItemId: WORK_ITEM_ID });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.evidenceFrames()).toHaveLength(0);

    await server.stop();
  }, 15000);

  it('rejects an unsafe workItemId at the ws-protocol boundary — no reply', async () => {
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const projectPath = await makeTmpRoot('unsafe-id');
    await initRepoWithDiffBase(projectPath);
    await seedStory(projectPath, WORK_ITEM_ID);
    server.instance.registry.pin(projectPath);

    const client = await connect(server.url);
    client.send({ type: 'evidence-request', path: projectPath, workItemId: '../x' });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.evidenceFrames()).toHaveLength(0);

    await server.stop();
  }, 15000);
});
