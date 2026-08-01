import { useState } from 'react';

import { ConnectionIndicator } from '@/components/ConnectionIndicator';
import { CostToday } from '@/components/CostToday';
import { Fleet } from '@/components/Fleet';
import { Heartbeat } from '@/components/Heartbeat';
import { HookBusIndicator } from '@/components/HookBusIndicator';
import { LeftRail, type TabId } from '@/components/LeftRail';
import { NeedsYouInbox } from '@/components/NeedsYouInbox';
import { ProjectPin } from '@/components/ProjectPin';
import { TeamRoom } from '@/components/TeamRoom';
import { useHeartbeat } from '@/hooks/useHeartbeat';
import { useProjects } from '@/hooks/useProjects';
import { deriveFleet } from '@/lib/fleet-state';

// Minimal centered shell: the live heartbeat + connection indicator, driven by
// the reconnecting WS client through useHeartbeat, plus the pin/unpin affordance
// and the Team room transcript panel. App owns the SINGLE useProjects() instance
// (one WS client per page) and feeds each child the slice it needs as props —
// ProjectPin, TeamRoom, Fleet, and LeftRail are all presentational. A left rail
// switches between the projects / fleet / inbox panels; only the active one renders.
function App() {
  const { status, heartbeat } = useHeartbeat();
  const [tab, setTab] = useState<TabId>('projects');
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
    sessionPersonas,
    bridgeStates,
    spawnSession,
    transcripts,
    sendSessionInput,
    interruptSession,
    pendingPermissions,
    resolvePermission,
    foreignNeedsYou,
    hookBusConnected,
    costToday,
  } = useProjects();

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-background p-8 text-foreground">
      <h1 className="text-4xl font-bold tracking-tight">DevOS</h1>
      <ConnectionIndicator status={status} />
      <HookBusIndicator connected={hookBusConnected} />
      <Heartbeat heartbeat={heartbeat} />
      <CostToday costToday={costToday} />
      <div className="flex w-full max-w-4xl flex-row gap-6">
        <LeftRail active={tab} onSelect={setTab} />
        <div className="flex flex-1 flex-col items-center gap-8">
          {tab === 'projects' && (
            <>
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
            </>
          )}
          {tab === 'fleet' && (
            <Fleet
              lanes={deriveFleet({
                sessions,
                sessionPersonas,
                transcripts,
                pendingPermissions,
                foreignNeedsYou,
                bridgeStates,
              })}
            />
          )}
          {tab === 'inbox' && (
            <NeedsYouInbox
              bridgeState={null}
              onApprove={() => {}}
              permissions={Object.values(pendingPermissions).flat()}
              onPermissionDecision={(sessionId, requestId, decision) =>
                resolvePermission(sessionId, requestId, decision)
              }
              foreignItems={foreignNeedsYou}
            />
          )}
        </div>
      </div>
    </main>
  );
}

export default App;
