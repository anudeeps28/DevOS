import { useEffect, useRef, useState } from 'react';

import {
  createWsClient,
  type BridgeState,
  type CostUsage,
  type ForeignNeedsYou,
  type GitState,
  type LifecycleSignals,
  type PermissionRequest,
  type RegistryCandidate,
  type RegistryProject,
  type RosterTimeline,
  type SessionPersona,
  type SessionState,
  type TrackerState,
  type TranscriptEvent,
  type WorkItemSessionAnchor,
  type WsClient,
  type WsClientOptions,
} from '@/lib/ws-client';

/** Client-side bound on the folded per-session transcript (mirrors the server buffer). */
const MAX_TRANSCRIPT_EVENTS = 500;

/** Client-side bound on the foreign-session needs-you list (memory guard). */
const MAX_FOREIGN_NEEDS_YOU = 100;

/**
 * Immutably fold a transcript batch into the existing per-session list: upsert
 * (replace) by `seq`, keep ascending `seq` order, and bound to the last
 * MAX_TRANSCRIPT_EVENTS events. Returns a NEW array; inputs are not mutated.
 */
function foldTranscript(
  prev: readonly TranscriptEvent[],
  incoming: readonly TranscriptEvent[],
): readonly TranscriptEvent[] {
  const bySeq = new Map<number, TranscriptEvent>();
  for (const event of prev) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > MAX_TRANSCRIPT_EVENTS
    ? merged.slice(merged.length - MAX_TRANSCRIPT_EVENTS)
    : merged;
}

/**
 * Immutably fold a session-personas snapshot into the existing per-path list:
 * upsert (replace) by `sessionId`, but RETAIN a previously non-null `persona`/
 * `phase` when the incoming entry for that session id has it as null — a late
 * join that hasn't resolved a phase yet shouldn't blank out a value the UI
 * already showed. Never throws. Returns a NEW map; inputs are not mutated.
 */
function foldPersonas(
  prev: Record<string, readonly SessionPersona[]>,
  path: string,
  incoming: readonly SessionPersona[],
): Record<string, readonly SessionPersona[]> {
  const prior = prev[path] ?? [];
  const priorById = new Map(prior.map((p) => [p.sessionId, p]));

  const merged = incoming.map((entry) => {
    const previousEntry = priorById.get(entry.sessionId);
    if (previousEntry === undefined) return entry;
    return {
      ...entry,
      persona: entry.persona ?? previousEntry.persona,
      phase: entry.phase ?? previousEntry.phase,
    };
  });

  return { ...prev, [path]: Object.freeze(merged) };
}

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
  /** Latest lifecycle-signals snapshots keyed by absolute project path; empty until the first arrives. */
  readonly lifecycleSignals: Record<string, LifecycleSignals>;
  /** Request a fresh lifecycle-signals read for a project path; delegates to the live client. */
  readonly requestLifecycleSignals: (path: string) => void;
  /** Latest owned-session states keyed by absolute project path (upserted by session id). */
  readonly sessions: Record<string, readonly SessionState[]>;
  /** Latest session-persona joins keyed by absolute project path (upserted by session id). */
  readonly sessionPersonas: Record<string, readonly SessionPersona[]>;
  /** Request a fresh session-personas join for a project path; delegates to the live client. */
  readonly requestSessionPersonas: (path: string) => void;
  /** Latest roster-timeline snapshots keyed by absolute project path; empty until the first arrives. */
  readonly rosterTimelines: Record<string, RosterTimeline>;
  /** Request a fresh roster-timeline read for a project path; delegates to the live client. */
  readonly requestRosterTimeline: (path: string) => void;
  /** Latest owned-session anchors keyed by work item id; empty until the first snapshot arrives. */
  readonly workItemSessions: Record<string, readonly WorkItemSessionAnchor[]>;
  /** Request the current owned-session anchors for a work item; delegates to the live client. */
  readonly requestWorkItemSessions: (path: string, workItemId: string) => void;
  /** Latest bridge-state snapshots keyed by absolute project path; empty until the first arrives. */
  readonly bridgeStates: Record<string, BridgeState>;
  /** Approve a parked bridge gate for a project path; delegates to the live client. */
  readonly approveGate: (path: string) => void;
  /** Spawn an owned session for a pinned project + role; delegates to the live client. */
  readonly spawnSession: (path: string, role: string, workItemId?: string) => void;
  /** Folded per-session transcripts keyed by session id (upserted + sorted by seq, bounded). */
  readonly transcripts: Record<string, readonly TranscriptEvent[]>;
  /** Request the buffered transcript of a live session; delegates to the live client. */
  readonly requestTranscript: (sessionId: string) => void;
  /** Steer a live owned session with mid-run user text; delegates to the live client. */
  readonly sendSessionInput: (sessionId: string, text: string) => void;
  /** Interrupt a live owned session's current turn; delegates to the live client. */
  readonly interruptSession: (sessionId: string) => void;
  /** Pending permission requests keyed by session id (upserted by requestId). */
  readonly pendingPermissions: Record<string, readonly PermissionRequest[]>;
  /** Resolve a pending permission request with an allow/deny decision; delegates to the live client. */
  readonly resolvePermission: (
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'allow-always',
  ) => void;
  /** Foreign-session needs-you signals, deduped by session id; cleared items are removed. */
  readonly foreignNeedsYou: readonly ForeignNeedsYou[];
  /** Whether the server's hook bus is currently connected. */
  readonly hookBusConnected: boolean;
  /** Latest validated cost/usage snapshot; null until the first one arrives. */
  readonly costToday: CostUsage | null;
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
  const [lifecycleSignals, setLifecycleSignals] = useState<Record<string, LifecycleSignals>>({});
  const [sessions, setSessions] = useState<Record<string, readonly SessionState[]>>({});
  const [sessionPersonas, setSessionPersonas] = useState<
    Record<string, readonly SessionPersona[]>
  >({});
  const [workItemSessions, setWorkItemSessions] = useState<
    Record<string, readonly WorkItemSessionAnchor[]>
  >({});
  const [bridgeStates, setBridgeStates] = useState<Record<string, BridgeState>>({});
  const [rosterTimelines, setRosterTimelines] = useState<Record<string, RosterTimeline>>({});
  const [transcripts, setTranscripts] = useState<Record<string, readonly TranscriptEvent[]>>({});
  const [pendingPermissions, setPendingPermissions] = useState<
    Record<string, readonly PermissionRequest[]>
  >({});
  const [foreignNeedsYou, setForeignNeedsYou] = useState<readonly ForeignNeedsYou[]>([]);
  const [hookBusConnected, setHookBusConnected] = useState(false);
  const [costToday, setCostToday] = useState<CostUsage | null>(null);

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

  // Hold the latest sessions so the mount-time onStatus handler can backfill
  // transcripts for whatever live sessions are known at (re)connect.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Session ids a transcript backfill has already been requested for ON THE
  // CURRENT CONNECTION — fired once per new live session id (not per snapshot).
  // Cleared whenever the connection drops so the next 'connected' re-requests
  // backfill for every still-live session (events emitted while disconnected
  // never reach this client and must be re-fetched from the server buffer).
  const requestedTranscriptsRef = useRef(new Set<string>());

  useEffect(() => {
    const factory = createClientRef.current ?? createWsClient;
    const client = factory();
    clientRef.current = client;
    // Single backfill-request path: request a session's transcript exactly once
    // per connection for each live session id (dedupe via requestedTranscriptsRef).
    const requestBackfill = (session: SessionState): void => {
      if (session.status !== 'running') return;
      if (requestedTranscriptsRef.current.has(session.id)) return;
      requestedTranscriptsRef.current.add(session.id);
      client.requestTranscript(session.id);
    };
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
    // Immutable fold: a lifecycle-signals snapshot replaces the map with a new object.
    const offLifecycleSignals = client.onLifecycleSignals((path, signals) =>
      setLifecycleSignals((prev) => ({ ...prev, [path]: signals })),
    );
    // Immutable fold: a session-state snapshot upserts by session id within the path.
    const offSessionState = client.onSessionState((path, session) => {
      setSessions((prev) => {
        const others = (prev[path] ?? []).filter((s) => s.id !== session.id);
        return { ...prev, [path]: [...others, session] };
      });
      // A NEW live session id triggers exactly one transcript backfill request.
      requestBackfill(session);
      // A session that stopped running has no more pending permission requests.
      if (session.status !== 'running') {
        setPendingPermissions((prev) => {
          if (!(session.id in prev)) return prev;
          const next = { ...prev };
          delete next[session.id];
          return next;
        });
      }
    });
    // Immutable fold: a session-personas snapshot upserts by session id within the
    // path, retaining a previously non-null persona/phase when the incoming entry
    // is null (see foldPersonas).
    const offSessionPersonas = client.onSessionPersonas((path, personas) =>
      setSessionPersonas((prev) => foldPersonas(prev, path, personas)),
    );
    // Immutable fold: a work-item-sessions snapshot replaces the entry for that
    // work item id with a new object.
    const offWorkItemSessions = client.onWorkItemSessions((_path, workItemId, sessions) =>
      setWorkItemSessions((prev) => ({ ...prev, [workItemId]: sessions })),
    );
    // Immutable fold: a bridge-state snapshot replaces the map with a new object.
    const offBridgeState = client.onBridgeState((path, bridgeState) =>
      setBridgeStates((prev) => ({ ...prev, [path]: bridgeState })),
    );
    // Immutable fold: a roster-timeline snapshot replaces the map with a new object.
    const offRosterTimeline = client.onRosterTimeline((path, timeline) =>
      setRosterTimelines((prev) => ({ ...prev, [path]: timeline })),
    );
    // Immutable fold: a permission request upserts by requestId within the session id.
    const offPermissionRequest = client.onPermissionRequest((req) =>
      setPendingPermissions((prev) => {
        const others = (prev[req.sessionId] ?? []).filter(
          (p) => p.requestId !== req.requestId,
        );
        return { ...prev, [req.sessionId]: [...others, req] };
      }),
    );
    // Immutable fold: a foreign-session needs-you signal upserts by session id;
    // a cleared signal removes the entry.
    const offForeignNeedsYou = client.onForeignNeedsYou((item) =>
      setForeignNeedsYou((prev) => {
        const others = prev.filter((x) => x.sessionId !== item.sessionId);
        if (item.cleared) return others;
        // Cap the list so a foreign process streaming many distinct sessionIds
        // (deduped only by sessionId) can't grow browser memory unbounded —
        // keep the most recent MAX_FOREIGN_NEEDS_YOU, dropping the oldest.
        const next = [...others, item];
        return next.length > MAX_FOREIGN_NEEDS_YOU
          ? next.slice(next.length - MAX_FOREIGN_NEEDS_YOU)
          : next;
      }),
    );
    const offHookBusLiveness = client.onHookBusLiveness((s) => setHookBusConnected(s.connected));
    const offCostUsage = client.onCostUsage(setCostToday);
    // Immutable fold: a transcript batch upserts by seq within the session id.
    const offSessionTranscript = client.onSessionTranscript((_path, sessionId, events) =>
      setTranscripts((prev) => ({
        ...prev,
        [sessionId]: foldTranscript(prev[sessionId] ?? [], events),
      })),
    );
    // Auto-refresh on connect: a freshly-opened socket requests a scan and a
    // git-state + tracker-state + lifecycle-signals read for every currently-known
    // pinned project.
    const offStatus = client.onStatus((status) => {
      if (status !== 'connected') {
        // Connection dropped (or is re-establishing): forget per-connection
        // backfill bookkeeping so the next 'connected' re-requests transcripts —
        // events emitted during the gap only exist in the server-side buffer.
        requestedTranscriptsRef.current = new Set();
        return;
      }
      client.discover();
      for (const project of projectsRef.current) {
        client.requestGitState(project.path);
        client.requestTrackerState(project.path);
        client.requestLifecycleSignals(project.path);
        client.requestSessionPersonas(project.path);
        client.requestRosterTimeline(project.path);
      }
      // Backfill transcripts for known live sessions not yet requested on
      // this connection.
      for (const sessionList of Object.values(sessionsRef.current)) {
        for (const session of sessionList) {
          requestBackfill(session);
        }
      }
    });

    return () => {
      offRegistry();
      offCandidates();
      offGitState();
      offTrackerState();
      offLifecycleSignals();
      offSessionState();
      offSessionPersonas();
      offWorkItemSessions();
      offBridgeState();
      offRosterTimeline();
      offSessionTranscript();
      offPermissionRequest();
      offForeignNeedsYou();
      offHookBusLiveness();
      offCostUsage();
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
      client.requestLifecycleSignals(project.path);
      client.requestSessionPersonas(project.path);
      client.requestRosterTimeline(project.path);
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

  function requestLifecycleSignals(path: string): void {
    clientRef.current?.requestLifecycleSignals(path);
  }

  function requestSessionPersonas(path: string): void {
    clientRef.current?.requestSessionPersonas(path);
  }

  function requestRosterTimeline(path: string): void {
    clientRef.current?.requestRosterTimeline(path);
  }

  function requestWorkItemSessions(path: string, workItemId: string): void {
    clientRef.current?.requestWorkItemSessions(path, workItemId);
  }

  function spawnSession(path: string, role: string, workItemId?: string): void {
    // Forward only the args given — don't pass an explicit `undefined` workItemId.
    if (workItemId !== undefined) {
      clientRef.current?.spawnSession(path, role, workItemId);
    } else {
      clientRef.current?.spawnSession(path, role);
    }
  }

  function requestTranscript(sessionId: string): void {
    clientRef.current?.requestTranscript(sessionId);
  }

  function sendSessionInput(sessionId: string, text: string): void {
    clientRef.current?.sendSessionInput(sessionId, text);
  }

  function interruptSession(sessionId: string): void {
    clientRef.current?.interruptSession(sessionId);
  }

  function resolvePermission(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'allow-always',
  ): void {
    clientRef.current?.sendPermissionDecision(sessionId, requestId, decision);
    setPendingPermissions((prev) => {
      const list = prev[sessionId];
      if (list === undefined) return prev;
      return { ...prev, [sessionId]: list.filter((p) => p.requestId !== requestId) };
    });
  }

  function approveGate(path: string): void {
    clientRef.current?.sendGateApprove(path);
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
    lifecycleSignals,
    requestLifecycleSignals,
    sessions,
    sessionPersonas,
    requestSessionPersonas,
    rosterTimelines,
    requestRosterTimeline,
    workItemSessions,
    requestWorkItemSessions,
    bridgeStates,
    approveGate,
    spawnSession,
    transcripts,
    requestTranscript,
    sendSessionInput,
    interruptSession,
    pendingPermissions,
    resolvePermission,
    foreignNeedsYou,
    hookBusConnected,
    costToday,
  };
}
