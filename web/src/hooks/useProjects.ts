import { useEffect, useRef, useState } from 'react';

import {
  createWsClient,
  type GitState,
  type RegistryCandidate,
  type RegistryProject,
  type TrackerState,
  type WsClient,
  type WsClientOptions,
} from '@/lib/ws-client';

export interface UseProjectsResult {
  /** Latest validated registry snapshot; empty until the first one arrives. */
  readonly projects: readonly RegistryProject[];
  /** Latest validated discovery-candidate snapshot; empty until the first one arrives. */
  readonly candidates: readonly RegistryCandidate[];
  /** Pin a project by absolute path; delegates to the live client. */
  readonly pin: (path: string, opts?: { displayName?: string; uiPrefs?: unknown }) => void;
  /** Unpin a project by absolute path; delegates to the live client. */
  readonly unpin: (path: string) => void;
  /** Request a fresh discovery scan; delegates to the live client. */
  readonly discover: () => void;
  /** Latest git-state snapshots keyed by absolute project path; empty until the first arrives. */
  readonly gitStates: Record<string, GitState>;
  /** Request a fresh git-state read for a project path; delegates to the live client. */
  readonly requestGitState: (path: string) => void;
  /** Latest tracker-state snapshots keyed by absolute project path; empty until the first arrives. */
  readonly trackerStates: Record<string, TrackerState>;
  /** Request a fresh tracker-state read for a project path; delegates to the live client. */
  readonly requestTrackerState: (path: string) => void;
}

export interface UseProjectsOptions {
  /** Inject a client factory (tests supply a fake); defaults to the real WS client. */
  readonly createClient?: (options?: WsClientOptions) => WsClient;
}

/**
 * React hook wrapping the reconnecting WS client for the project registry. Owns
 * the client for the component's lifetime: created on mount, torn down (closed)
 * on unmount. State updates are immutable — setProjects replaces the prior array.
 */
export function useProjects(options: UseProjectsOptions = {}): UseProjectsResult {
  const [projects, setProjects] = useState<readonly RegistryProject[]>([]);
  const [candidates, setCandidates] = useState<readonly RegistryCandidate[]>([]);
  const [gitStates, setGitStates] = useState<Record<string, GitState>>({});
  const [trackerStates, setTrackerStates] = useState<Record<string, TrackerState>>({});

  // Hold the latest factory in a ref so the setup effect can run once (on mount)
  // without re-subscribing when an inline options object changes identity.
  const createClientRef = useRef(options.createClient);
  createClientRef.current = options.createClient;

  // Hold the live client so pin/unpin can delegate to it after mount.
  const clientRef = useRef<WsClient | null>(null);

  // Hold the latest projects so the mount-time onStatus handler (which closes
  // over mount state) can request git-state for whatever is known at connect.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => {
    const factory = createClientRef.current ?? createWsClient;
    const client = factory();
    clientRef.current = client;
    const offRegistry = client.onRegistry(setProjects);
    const offCandidates = client.onCandidates(setCandidates);
    // Immutable fold: a git-state snapshot replaces the map with a new object.
    const offGitState = client.onGitState((path, state) =>
      setGitStates((prev) => ({ ...prev, [path]: state })),
    );
    // Immutable fold: a tracker-state snapshot replaces the map with a new object.
    const offTrackerState = client.onTrackerState((path, state) =>
      setTrackerStates((prev) => ({ ...prev, [path]: state })),
    );
    // Auto-refresh on connect: a freshly-opened socket requests a scan and a
    // git-state + tracker-state read for every currently-known pinned project.
    const offStatus = client.onStatus((status) => {
      if (status === 'connected') {
        client.discover();
        for (const project of projectsRef.current) {
          client.requestGitState(project.path);
          client.requestTrackerState(project.path);
        }
      }
    });

    return () => {
      offRegistry();
      offCandidates();
      offGitState();
      offTrackerState();
      offStatus();
      client.close();
      clientRef.current = null;
    };
  }, []);

  // Whenever the pinned project set changes, request a fresh git-state read for
  // each project. The registry snapshot may arrive after connect, so this covers
  // projects that appear once the socket is already open.
  useEffect(() => {
    const client = clientRef.current;
    if (client === null) return;
    for (const project of projects) {
      client.requestGitState(project.path);
      client.requestTrackerState(project.path);
    }
  }, [projects]);

  function pin(path: string, opts?: { displayName?: string; uiPrefs?: unknown }): void {
    clientRef.current?.pin(path, opts);
  }

  function unpin(path: string): void {
    clientRef.current?.unpin(path);
  }

  function discover(): void {
    clientRef.current?.discover();
  }

  function requestGitState(path: string): void {
    clientRef.current?.requestGitState(path);
  }

  function requestTrackerState(path: string): void {
    clientRef.current?.requestTrackerState(path);
  }

  return {
    projects,
    candidates,
    pin,
    unpin,
    discover,
    gitStates,
    requestGitState,
    trackerStates,
    requestTrackerState,
  };
}
