import { useEffect, useRef, useState } from 'react';

import {
  createWsClient,
  type ConnectionStatus,
  type Heartbeat,
  type WsClient,
  type WsClientOptions,
} from '@/lib/ws-client';

export interface UseHeartbeatResult {
  readonly status: ConnectionStatus;
  /** Latest validated heartbeat, or null before the first one arrives. */
  readonly heartbeat: Heartbeat | null;
}

export interface UseHeartbeatOptions {
  /** Inject a client factory (tests supply a fake); defaults to the real WS client. */
  readonly createClient?: (options?: WsClientOptions) => WsClient;
}

/**
 * React hook wrapping the reconnecting WS client. Owns the client for the
 * component's lifetime: created on mount, torn down (closed) on unmount.
 * State updates are immutable — setStatus/setHeartbeat replace prior values.
 */
export function useHeartbeat(options: UseHeartbeatOptions = {}): UseHeartbeatResult {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [heartbeat, setHeartbeat] = useState<Heartbeat | null>(null);

  // Hold the latest factory in a ref so the setup effect can run once (on mount)
  // without re-subscribing when an inline options object changes identity.
  const createClientRef = useRef(options.createClient);
  createClientRef.current = options.createClient;

  useEffect(() => {
    const factory = createClientRef.current ?? createWsClient;
    const client = factory();
    const offStatus = client.onStatus(setStatus);
    const offHeartbeat = client.onHeartbeat(setHeartbeat);

    return () => {
      offStatus();
      offHeartbeat();
      client.close();
    };
  }, []);

  return { status, heartbeat };
}
