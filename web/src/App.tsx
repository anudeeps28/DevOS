import { ConnectionIndicator } from '@/components/ConnectionIndicator';
import { Heartbeat } from '@/components/Heartbeat';
import { ProjectPin } from '@/components/ProjectPin';
import { useHeartbeat } from '@/hooks/useHeartbeat';

// Minimal centered shell: the live heartbeat + connection indicator, driven by
// the reconnecting WS client through useHeartbeat, plus the pin/unpin affordance.
function App() {
  const { status, heartbeat } = useHeartbeat();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background text-foreground">
      <h1 className="text-4xl font-bold tracking-tight">DevOS</h1>
      <ConnectionIndicator status={status} />
      <Heartbeat heartbeat={heartbeat} />
      <ProjectPin />
    </main>
  );
}

export default App;
