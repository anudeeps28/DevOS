import { ConnectionIndicator } from '@/components/ConnectionIndicator';
import { Heartbeat } from '@/components/Heartbeat';
import { NeedsYouInbox } from '@/components/NeedsYouInbox';
import { ProjectPin } from '@/components/ProjectPin';
import { TeamRoom } from '@/components/TeamRoom';
import { useHeartbeat } from '@/hooks/useHeartbeat';
import { useProjects } from '@/hooks/useProjects';

// Minimal centered shell: the live heartbeat + connection indicator, driven by
// the reconnecting WS client through useHeartbeat, plus the pin/unpin affordance
// and the Team room transcript panel. App owns the SINGLE useProjects() instance
// (one WS client per page) and feeds each child the slice it needs as props —
// ProjectPin and TeamRoom are presentational.
function App() {
  const { status, heartbeat } = useHeartbeat();
  const {
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
    spawnSession,
    transcripts,
    sendSessionInput,
    interruptSession,
    pendingPermissions,
    resolvePermission,
  } = useProjects();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background text-foreground">
      <h1 className="text-4xl font-bold tracking-tight">DevOS</h1>
      <ConnectionIndicator status={status} />
      <Heartbeat heartbeat={heartbeat} />
      <ProjectPin
        projects={projects}
        candidates={candidates}
        pin={pin}
        unpin={unpin}
        discover={discover}
        gitStates={gitStates}
        requestGitState={requestGitState}
        trackerStates={trackerStates}
        requestTrackerState={requestTrackerState}
        lifecycleSignals={lifecycleSignals}
        requestLifecycleSignals={requestLifecycleSignals}
        sessions={sessions}
        spawnSession={spawnSession}
      />
      <TeamRoom
        sessions={sessions}
        transcripts={transcripts}
        sendSessionInput={sendSessionInput}
        interruptSession={interruptSession}
        pendingPermissions={pendingPermissions}
        resolvePermission={resolvePermission}
      />
      <NeedsYouInbox
        bridgeState={null}
        onApprove={() => {}}
        permissions={Object.values(pendingPermissions).flat()}
        onPermissionDecision={(sessionId, requestId, decision) =>
          resolvePermission(sessionId, requestId, decision)
        }
      />
    </main>
  );
}

export default App;
