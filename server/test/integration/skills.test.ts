// Integration test — skills read round-trip over the live WS transport.
//
// Boots the REAL server in-process on a free port (PORT=0) with an explicit,
// per-test on-disk SQLite file AND per-test tmp fixture dirs, opens a real `ws`
// client, sends `{type:'skills', path}`, awaits the snapshot frame, and asserts
// on `state`:
//   AC1 — a fixture with an org skill (alpha) and a local skill (beta) → the
//         snapshot's state.skills contains both, correctly scoped and parsed.
//   AC3 — an UNPINNED path never yields a skills frame (fail-closed), and the
//         gateway STAYS UP for a subsequent PINNED read.
//   never-cached — a fresh skill added to disk after an initial read appears on
//         a subsequent read (proves live-derive, no server-side memoization).
//
// Isolation: every test uses its OWN tmp fixtures + tmp DB file (never the real
// app-data DB). afterEach removes the fixture trees and the .db/.db-wal/.db-shm
// sidecars. The server is created with NO project roots — every read targets an
// explicit absolute path, so discovery never interferes.

import { promises as fs } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';
import { WS_PATH } from '../../src/config.js';
import type { SkillsState } from '../../src/ws-protocol.js';

/** Write `<dir>/.claude/skills/<dirName>/SKILL.md` with `---`-fenced frontmatter. */
async function writeSkill(
  dir: string,
  dirName: string,
  name: string,
  description: string,
): Promise<void> {
  const skillDir = join(dir, '.claude', 'skills', dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.\n`,
  );
}

/** Write `<dir>/.claude/.harness-manifest.json` with the given installedFiles. */
async function writeManifest(dir: string, installedFiles: readonly string[]): Promise<void> {
  await fs.mkdir(join(dir, '.claude'), { recursive: true });
  await fs.writeFile(
    join(dir, '.claude', '.harness-manifest.json'),
    JSON.stringify({ installedFiles }),
  );
}

/** Build a fixture dir with an org skill (alpha) and a local skill (beta). */
async function buildFixture(dir: string): Promise<void> {
  await writeSkill(dir, 'alpha', 'alpha', 'Alpha skill description');
  await writeSkill(dir, 'beta', 'beta', 'Beta skill description');
  await writeManifest(dir, ['skills/alpha/SKILL.md']);
}

interface SkillsFrame {
  readonly type: 'skills';
  readonly path: string;
  readonly state: SkillsState;
}

function isSkillsFrame(value: unknown): value is SkillsFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'skills' &&
    typeof frame.path === 'string' &&
    typeof frame.state === 'object' &&
    frame.state !== null
  );
}

// A thin test client around a real `ws` socket. `waitForSkills` resolves on the
// next FUTURE skills frame matching a predicate, with a safety-net timeout — the
// timer only guards against a hung/absent stream. Heartbeats and other frames are
// ignored by the waiter.
interface TestClient {
  readonly send: (message: unknown) => void;
  readonly waitForSkills: (
    predicate: (frame: SkillsFrame) => boolean,
    timeoutMs: number,
  ) => Promise<SkillsFrame>;
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
    let skillsWaiters: Array<Waiter<SkillsFrame>> = [];
    let opened = false;

    const openTimer = setTimeout(() => {
      if (!opened) {
        socket.removeAllListeners();
        socket.close();
        reject(new Error(`Timed out after ${openTimeoutMs}ms waiting for ws 'open'`));
      }
    }, openTimeoutMs);

    const failAll = (error: Error): void => {
      const pending = skillsWaiters;
      skillsWaiters = [];
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

      if (isSkillsFrame(parsed)) {
        const frame = parsed;
        const stillWaiting: Array<Waiter<SkillsFrame>> = [];
        for (const waiter of skillsWaiters) {
          if (waiter.predicate(frame)) {
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          } else {
            stillWaiting.push(waiter);
          }
        }
        skillsWaiters = stillWaiting;
        return;
      }
      // Heartbeat / registry / anything else — ignore.
    });

    socket.on('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send: (message: unknown) => socket.send(JSON.stringify(message)),
        waitForSkills: (predicate, timeoutMs) =>
          new Promise<SkillsFrame>((res, rej) => {
            const timer = setTimeout(() => {
              skillsWaiters = skillsWaiters.filter((w) => w.timer !== timer);
              rej(
                new Error(`Timed out after ${timeoutMs}ms waiting for a matching skills snapshot`),
              );
            }, timeoutMs);
            skillsWaiters.push({ predicate, resolve: res, reject: rej, timer });
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
// The current server's registry, set in startServer — readSkillsState pins each
// path through it so the read passes the gateway's pinned-path allowlist.
let activeRegistry: import('../../src/registry/registry.js').Registry | null = null;

function makeTmpDbPath(): string {
  const path = join(tmpdir(), `devos-skills-${randomUUID()}.db`);
  tmpDbPaths.push(path);
  return path;
}

/** Create a tracked tmp root directory (recursively removed in afterEach). */
async function makeTmpRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `devos-skills-${prefix}-${randomUUID()}`);
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
  // No project roots: skills reads target explicit absolute paths, so discovery
  // never runs and never interferes with the frames under test.
  const instance = createServer({ port: 0, dbPath, projectRoots: [] });
  // The read handler allowlists to PINNED projects; readSkillsState() pins each
  // path first.
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

// Read skills state for `path` over a FRESH socket. Each new socket resets the
// per-socket SKILLS_MIN_INTERVAL_MS flood-guard to 0, so every read here is
// accepted immediately and independently — no debounce interference, and it
// proves the server never memoizes (each read hits `readSkills` afresh).
async function readSkillsState(url: string, path: string): Promise<SkillsState> {
  activeRegistry?.pin(path); // pass the pinned-path allowlist
  const client = await connect(url);
  const framePromise = client.waitForSkills((f) => f.path === path, 3000);
  client.send({ type: 'skills', path });
  const frame = await framePromise;
  return frame.state;
}

describe('skills read round-trip over the live WS transport', () => {
  it('AC1 — reports org vs local scope and parsed name/description for a pinned fixture', async () => {
    // Given: a pinned fixture with an org skill (alpha) and a local skill (beta).
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const dir = await makeTmpRoot('org-local');
    await buildFixture(dir);

    // When: reading skills state over the live WS transport.
    const state = await readSkillsState(server.url, dir);

    // Then: both skills are present, correctly scoped and parsed.
    expect(state.path).toBe(dir);
    expect(state.skills).toHaveLength(2);

    const alpha = state.skills.find((s) => s.name === 'alpha');
    const beta = state.skills.find((s) => s.name === 'beta');

    expect(alpha).toBeDefined();
    expect(alpha?.scope).toBe('org');
    expect(alpha?.description).toBe('Alpha skill description');

    expect(beta).toBeDefined();
    expect(beta?.scope).toBe('local');
    expect(beta?.description).toBe('Beta skill description');

    await server.stop();
  }, 15000);

  it('AC3 — an unpinned path never yields a skills frame; gateway stays up for a subsequent pinned read', async () => {
    // Given: a fixture dir that is NEVER pinned.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const unpinned = await makeTmpRoot('unpinned');
    await buildFixture(unpinned);

    // When: an UNPINNED read is sent on a fresh socket (deliberately NOT pinned
    // via the registry, unlike readSkillsState()).
    const client = await connect(server.url);
    const failClosedPromise = client.waitForSkills((f) => f.path === unpinned, 500);
    client.send({ type: 'skills', path: unpinned });

    // Then: no skills frame ever arrives for the unpinned path — fail closed.
    await expect(failClosedPromise).rejects.toThrow(/Timed out/);

    // Then: the gateway is still UP — a subsequent PINNED read round-trips.
    const pinned = await makeTmpRoot('unpinned-then-pinned');
    await buildFixture(pinned);
    const state = await readSkillsState(server.url, pinned);
    expect(state.path).toBe(pinned);
    expect(state.skills).toHaveLength(2);

    await server.stop();
  }, 15000);

  it('never caches — a skill added to disk after an initial read appears on a fresh read', async () => {
    // Given: a pinned fixture with the two initial skills.
    const dbPath = makeTmpDbPath();
    const server = await startServer(dbPath);
    const dir = await makeTmpRoot('nocache');
    await buildFixture(dir);

    // When: reading skills state → only alpha/beta are present.
    const first = await readSkillsState(server.url, dir);
    expect(first.skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);

    // When: a THIRD skill is added on disk with NO app interaction...
    await writeSkill(dir, 'gamma', 'gamma', 'Gamma skill description');

    // ...and a FRESH skills read is sent (on a fresh socket, unaffected by the
    // per-socket 200ms flood-guard on the first socket).
    const second = await readSkillsState(server.url, dir);

    // Then: the read is not cached — the new skill is reported.
    expect(second.skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
    const gamma = second.skills.find((s) => s.name === 'gamma');
    expect(gamma?.scope).toBe('local');
    expect(gamma?.description).toBe('Gamma skill description');

    await server.stop();
  }, 15000);
});
