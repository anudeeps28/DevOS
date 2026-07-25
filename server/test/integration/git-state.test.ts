// Integration test — git-state read round-trip over the live WS transport.
//
// Boots the REAL server in-process on a free port (PORT=0) with an explicit,
// per-test on-disk SQLite file AND per-test tmp git fixtures, opens a real `ws`
// client, sends `{type:'git-state', path}`, awaits the snapshot frame, and asserts
// on `state`:
//   AC1 — a repo with a commit on `main`, a dirtied tracked file, and a LOCAL
//         (offline) upstream diverged by N: state.branch/dirty/ahead/behind.
//   AC2 — read state on branch A, `git checkout -b other` on the SAME repo with NO
//         app interaction, then a FRESH read reports `other` (proves no caching).
//   AC3 — a non-git dir AND a missing path both yield a well-formed frame with
//         state.isRepo:false, and the gateway STAYS UP for a subsequent real read.
//   AC4 — a detached-HEAD repo → detached:true, branch:null; a no-upstream repo →
//         ahead:null, behind:null, upstream:null.
//
// Git fixtures run through execFile with an inline headless identity and a neutered
// global/system config — fully offline, no ambient git identity, no network.
//
// Isolation: every test uses its OWN tmp fixtures + tmp DB file (never the real
// app-data DB). afterEach removes the fixture trees and the .db/.db-wal/.db-shm
// sidecars. The server is created with NO project roots — every read targets an
// explicit absolute path, so discovery never interferes.

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
import type { GitState } from '../../src/ws-protocol.js';

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

/** Init a repo at `dir` and land one commit on `main` with a tracked file. */
async function initRepoWithCommit(dir: string): Promise<void> {
  await git(dir, ['init']);
  await fs.writeFile(join(dir, 'file.txt'), 'v1\n');
  await git(dir, ['add', 'file.txt']);
  await git(dir, ['commit', '-m', 'initial']);
}

interface GitStateFrame {
  readonly type: 'git-state';
  readonly path: string;
  readonly state: GitState;
}

function isGitStateFrame(value: unknown): value is GitStateFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'git-state' &&
    typeof frame.path === 'string' &&
    typeof frame.state === 'object' &&
    frame.state !== null
  );
}

// A thin test client around a real `ws` socket. `waitForGitState` resolves on the
// next FUTURE git-state frame matching a predicate, with a safety-net timeout — the
// timer only guards against a hung/absent stream. Heartbeats and other frames are
// ignored by the waiter.
interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForGitState: (
    predicate: (frame: GitStateFrame) => boolean,
    timeoutMs: number,
  ) => Promise<GitStateFrame>;
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
    let gitStateWaiters: Array<Waiter<GitStateFrame>> = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    const failAll = (error: Error): void => {
      const pending = gitStateWaiters;
      gitStateWaiters = [];
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
        // Non-JSON on the wire is not expected from the server; ignore.
        return;
      }

      if (isGitStateFrame(parsed)) {
        const frame = parsed;
        const stillWaiting: Array<Waiter<GitStateFrame>> = [];
        for (const waiter of gitStateWaiters) {
          if (waiter.predicate(frame)) {
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          } else {
            stillWaiting.push(waiter);
          }
        }
        gitStateWaiters = stillWaiting;
        return;
      }
      // Heartbeat / registry / anything else — ignore.
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send: (message: unknown) => socket.send(JSON.stringify(message)),
        waitForGitState: (predicate, timeoutMs) =>
          new Promise<GitStateFrame>((res, rej) => {
            const timer = setTimeout(() => {
              gitStateWaiters = gitStateWaiters.filter((w) => w.timer !== timer);
              rej(
                new Error(
                  `Timed out after ${timeoutMs}ms waiting for a matching git-state snapshot`,
                ),
              );
            }, timeoutMs);
            gitStateWaiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
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
// The current server's registry, set in startServer — readState pins each path
// through it so the read passes the gateway's pinned-path allowlist.
let activeRegistry: import('../../src/registry/registry.js').Registry | null = null;

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-gitstate-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

/** Create a tracked tmp root directory (recursively removed in afterEach). */
async function makeTmpRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `devos-gitstate-${prefix}-${randomUUID()}`);
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
  // No project roots: git-state reads target explicit absolute paths, so discovery
  // never runs and never interferes with the frames under test.
  const instance = createServer({ port: 0, dbPath, projectRoots: [] });
  // The read handlers allowlist to PINNED projects; readState() pins each path first.
  activeRegistry = instance.registry;
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

// Read git state for `path` over a FRESH socket. Each new socket resets the
// per-socket GIT_STATE_MIN_INTERVAL_MS flood-guard to 0, so every read here is
// accepted immediately and independently — no debounce interference, and it proves
// the server never memoizes (each read hits `readGitState` afresh).
async function readState(url: string, path: string): Promise<GitState> {
  activeRegistry?.pin(path); // pass the pinned-path allowlist
  const client = await connect(url);
  const framePromise = client.waitForGitState((f) => f.path === path, 3000);
  client.send({ type: 'git-state', path });
  const frame = await framePromise;
  return frame.state;
}

describe('git-state read round-trip over the live WS transport', () => {
  it('AC1 — reports branch, dirty, and exact ahead/behind against a local upstream', async () => {
    // Given: a bare "origin" and a working clone diverged from its upstream WITHOUT
    // any fetch/network (ahead:1, behind:2), plus a dirtied tracked file.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const root = await makeTmpRoot('aheadbehind');
    const bare = join(root, 'origin.git');
    const work = join(root, 'work');
    await fs.mkdir(work, { recursive: true });
    await git(root, ['init', '--bare', 'origin.git']);

    await initRepoWithCommit(work);
    const c1 = await git(work, ['rev-parse', 'HEAD']);
    await git(work, ['remote', 'add', 'origin', bare]);
    await git(work, ['push', '-u', 'origin', 'main']);

    await fs.writeFile(join(work, 'file.txt'), 'v2\n');
    await git(work, ['commit', '-am', 'c2']);
    await fs.writeFile(join(work, 'file.txt'), 'v3\n');
    await git(work, ['commit', '-am', 'c3']);
    await git(work, ['push', 'origin', 'main']);

    await git(work, ['reset', '--hard', c1]);
    await fs.writeFile(join(work, 'other.txt'), 'c4\n');
    await git(work, ['add', 'other.txt']);
    await git(work, ['commit', '-m', 'c4']);

    // Dirty the tree: modify a tracked file without committing.
    await fs.writeFile(join(work, 'file.txt'), 'dirtied-uncommitted\n');

    // When: reading git state over the live WS transport.
    const state = await readState(server.url, work);

    // Then: branch/dirty/ahead/behind/upstream reflect the diverged, dirtied tree.
    expect(state.isRepo).toBe(true);
    expect(state.branch).toBe('main');
    expect(state.dirty).toBe(true);
    expect(state.ahead).toBe(1);
    expect(state.behind).toBe(2);
    expect(state.upstream).toBe('origin/main');

    await server.stop();
  }, 15000);

  it('AC2 — a fresh read after checkout reflects the new branch (no caching)', async () => {
    // Given: a repo on `main`.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const work = await makeTmpRoot('nocache');
    await initRepoWithCommit(work);

    // When: reading state → branch is `main`.
    const first = await readState(server.url, work);
    expect(first.branch).toBe('main');

    // When: the branch changes on the SAME repo with NO app interaction...
    await git(work, ['checkout', '-b', 'other']);

    // ...and a FRESH git-state is sent (on a fresh socket, unaffected by the
    // per-socket 200ms flood-guard on the first socket).
    const second = await readState(server.url, work);

    // Then: the read is not cached — the new branch is reported.
    expect(second.branch).toBe('other');

    await server.stop();
  }, 15000);

  it('AC3 — a non-git dir and a missing path yield isRepo:false; gateway stays up', async () => {
    // Given: a plain (non-git) tmp dir and a path that was never created.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const nonGit = await makeTmpRoot('nongit');
    const missing = join(tmpdir(), `devos-gitstate-missing-${randomUUID()}`);

    // When: reading a non-git dir → a well-formed frame with isRepo:false.
    const nonGitState = await readState(server.url, nonGit);
    expect(nonGitState.isRepo).toBe(false);
    expect(nonGitState.branch).toBeNull();
    expect(nonGitState.detached).toBe(false);
    expect(nonGitState.dirty).toBe(false);
    expect(nonGitState.ahead).toBeNull();
    expect(nonGitState.behind).toBeNull();
    expect(nonGitState.upstream).toBeNull();

    // When: reading a missing path → the same well-formed unavailable frame.
    const missingState = await readState(server.url, missing);
    expect(missingState.isRepo).toBe(false);
    expect(missingState.branch).toBeNull();

    // Then: the gateway is still UP — a subsequent read of a REAL repo round-trips.
    const work = await makeTmpRoot('nongit-real');
    await initRepoWithCommit(work);
    const realState = await readState(server.url, work);
    expect(realState.isRepo).toBe(true);
    expect(realState.branch).toBe('main');

    await server.stop();
  }, 15000);

  it('fans out per-path on a SINGLE socket — every pinned project gets its snapshot', async () => {
    // Regression for the per-socket flood-guard: the client sends one git-state
    // frame per pinned project in a burst on ONE socket. A per-socket scalar guard
    // would drop every project after the first; the guard must be keyed per-path so
    // all distinct paths pass. (A per-socket-scalar guard makes this test hang/fail.)
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);

    // Given: three distinct pinned repos, each on its own branch.
    const repos: Array<{ path: string; branch: string }> = [];
    for (let i = 0; i < 3; i++) {
      const dir = await makeTmpRoot(`fanout-${i}`);
      await initRepoWithCommit(dir);
      const branch = `feat-${i}`;
      await git(dir, ['checkout', '-b', branch]);
      server.instance.registry.pin(dir); // pass the pinned-path allowlist
      repos.push({ path: dir, branch });
    }

    // When: a single client bursts one git-state request per repo on ONE socket.
    const client = await connect(server.url);
    const framePromises = repos.map((r) =>
      client.waitForGitState((f) => f.path === r.path, 5000),
    );
    for (const r of repos) {
      client.send({ type: 'git-state', path: r.path });
    }
    const frames = await Promise.all(framePromises);

    // Then: every repo received its own snapshot with the correct branch — none
    // was silently dropped by the flood-guard.
    for (const r of repos) {
      const frame = frames.find((f) => f.path === r.path);
      expect(frame, `no snapshot for ${r.path}`).toBeDefined();
      expect(frame?.state.isRepo).toBe(true);
      expect(frame?.state.branch).toBe(r.branch);
    }

    await server.stop();
  }, 15000);

  it('AC4 — detached HEAD and no-upstream repos report the expected null/detached shape', async () => {
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);

    // Given: a repo checked out directly at a commit sha (detached HEAD).
    const detachedRepo = await makeTmpRoot('detached');
    await initRepoWithCommit(detachedRepo);
    const sha = await git(detachedRepo, ['rev-parse', 'HEAD']);
    await git(detachedRepo, ['checkout', sha]);

    // When: reading its state → HEAD is detached and no branch name is reported.
    const detachedState = await readState(server.url, detachedRepo);
    expect(detachedState.isRepo).toBe(true);
    expect(detachedState.detached).toBe(true);
    expect(detachedState.branch).toBeNull();

    // Given: a repo whose branch has no upstream tracking ref.
    const noUpstreamRepo = await makeTmpRoot('noupstream');
    await initRepoWithCommit(noUpstreamRepo);

    // When: reading its state → ahead/behind/upstream are null (NOT 0).
    const noUpstreamState = await readState(server.url, noUpstreamRepo);
    expect(noUpstreamState.isRepo).toBe(true);
    expect(noUpstreamState.ahead).toBeNull();
    expect(noUpstreamState.behind).toBeNull();
    expect(noUpstreamState.upstream).toBeNull();

    await server.stop();
  }, 15000);
});
