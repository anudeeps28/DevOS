import { useMemo, useState } from 'react';

import { Board } from '@/components/Board';
import { ConnectionIndicator } from '@/components/ConnectionIndicator';
import { CostToday } from '@/components/CostToday';
import { Fleet } from '@/components/Fleet';
import { Heartbeat } from '@/components/Heartbeat';
import { HookBusIndicator } from '@/components/HookBusIndicator';
import { LeftRail, type TabId } from '@/components/LeftRail';
import { NeedsYouInbox } from '@/components/NeedsYouInbox';
import { ProjectPin } from '@/components/ProjectPin';
import { SkillsPanel } from '@/components/SkillsPanel';
import { TeamRoom } from '@/components/TeamRoom';
import { WorkItemDetail } from '@/components/WorkItemDetail';
import { useHeartbeat } from '@/hooks/useHeartbeat';
import { useNeedsYouToast } from '@/hooks/useNeedsYouToast';
import { useProjects } from '@/hooks/useProjects';
import { deriveBoard } from '@/lib/board-state';
import { deriveFleet } from '@/lib/fleet-state';
import { deriveNeedsYou } from '@/lib/needs-you';
import { derivePipelineTimeline } from '@/lib/pipeline-timeline';

// Minimal centered shell: the live heartbeat + connection indicator, driven by
// the reconnecting WS client through useHeartbeat, plus the pin/unpin affordance
// and the Team room transcript panel. App owns the SINGLE useProjects() instance
// (one WS client per page) and feeds each child the slice it needs as props —
// ProjectPin, TeamRoom, Fleet, and LeftRail are all presentational. A left rail
// switches between the projects / fleet / inbox panels; only the active one renders.
function App() {
  const { status, heartbeat } = useHeartbeat();
  const [tab, setTab] = useState<TabId>('projects');
  const [selected, setSelected] = useState<{ workItemId: string; path: string } | null>(null);
  const {
    projects,
    candidates,
    pin,
    unpin,
    discover,
    gitStates,
    requestGitState,
    skills,
    requestSkills,
    trackerStates,
    requestTrackerState,
    lifecycleSignals,
    requestLifecycleSignals,
    sessions,
    sessionPersonas,
    bridgeStates,
    rosterTimelines,
    approveGate,
    requestChanges,
    answerQuestion,
    resolveEscalation,
    spawnSession,
    bridgeStart,
    transcripts,
    sendSessionInput,
    interruptSession,
    pendingPermissions,
    resolvePermission,
    foreignNeedsYou,
    hookBusConnected,
    costToday,
    workItemSessions,
    requestWorkItemSessions,
    evidence,
    requestEvidence,
  } = useProjects();

  const needsYouItems = useMemo(
    () => deriveNeedsYou({ pendingPermissions, bridgeStates, foreignNeedsYou }),
    [pendingPermissions, bridgeStates, foreignNeedsYou],
  );
  useNeedsYouToast(needsYouItems);

  const boardModel = useMemo(
    () => deriveBoard({ sessionPersonas, bridgeStates, trackerStates }),
    [sessionPersonas, bridgeStates, trackerStates],
  );

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-background p-8 text-foreground">
      <h1 className="text-4xl font-bold tracking-tight">DevOS</h1>
      <ConnectionIndicator status={status} />
      <HookBusIndicator connected={hookBusConnected} />
      <Heartbeat heartbeat={heartbeat} />
      <CostToday costToday={costToday} />
      <div className="flex w-full max-w-4xl flex-row gap-6">
        <LeftRail
          active={tab}
          onSelect={(next) => {
            // Leaving the Work-item Detail overlay when the user picks a tab —
            // otherwise Detail keeps covering the shell and the tab click looks inert.
            setSelected(null);
            setTab(next);
          }}
          badges={{ inbox: needsYouItems.length }}
        />
        <div className="flex flex-1 flex-col items-center gap-8">
          {selected !== null ? (
            <WorkItemDetail
              workItemId={selected.workItemId}
              model={derivePipelineTimeline({
                rosterTimeline: rosterTimelines[selected.path],
                sessionPersonas: sessionPersonas[selected.path] ?? [],
                workItemId: selected.workItemId,
                bridgeState: bridgeStates[selected.path],
              })}
              evidence={evidence[selected.workItemId]}
              onBack={() => setSelected(null)}
              onRequestEvidence={() => requestEvidence(selected.path, selected.workItemId)}
            />
          ) : (
            <>
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
                onAssignWork={(path, workItemId) => {
                  bridgeStart(path, workItemId);
                  setSelected({ workItemId, path });
                }}
              />
              <TeamRoom
                sessions={sessions}
                transcripts={transcripts}
                sendSessionInput={sendSessionInput}
                interruptSession={interruptSession}
                pendingPermissions={pendingPermissions}
                resolvePermission={resolvePermission}
                workItemSessions={workItemSessions}
                requestWorkItemSessions={requestWorkItemSessions}
                connected={status === 'connected'}
              />
            </>
          )}
          {tab === 'skills' && (
            <SkillsPanel projects={projects} skills={skills} requestSkills={requestSkills} />
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
              onOpenItem={(workItemId, path) => setSelected({ workItemId, path })}
            />
          )}
          {tab === 'board' && (
            <Board model={boardModel} onOpenItem={(workItemId, path) => setSelected({ workItemId, path })} />
          )}
          {tab === 'inbox' && (
            <NeedsYouInbox
              items={needsYouItems}
              onApprove={approveGate}
              onRequestChanges={requestChanges}
              onAnswerQuestion={answerQuestion}
              onEscalationChoice={resolveEscalation}
              onPermissionDecision={(sessionId, requestId, decision) =>
                resolvePermission(sessionId, requestId, decision)
              }
            />
          )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

export default App;
