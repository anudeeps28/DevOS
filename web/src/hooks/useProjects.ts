import { useEffect, useRef, useState } from 'react';

import {
  createWsClient,
  type RegistryProject,
  type WsClient,
  type WsClientOptions,
} from '@/lib/ws-client';

export interface UseProjectsResult {
  /** Latest validated registry snapshot; empty until the first one arrives. */
  readonly projects: readonly RegistryProject[];
  /** Pin a project by absolute path; delegates to the live client. */
  readonly pin: (path: string, opts?: { displayName?: string; uiPrefs?: unknown }) => void;
  /** Unpin a project by absolute path; delegates to the live client. */
  readonly unpin: (path: string) => void;
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

  // Hold the latest factory in a ref so the setup effect can run once (on mount)
  // without re-subscribing when an inline options object changes identity.
  const createClientRef = useRef(options.createClient);
  createClientRef.current = options.createClient;

  // Hold the live client so pin/unpin can delegate to it after mount.
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const factory = createClientRef.current ?? createWsClient;
    const client = factory();
    clientRef.current = client;
    const offRegistry = client.onRegistry(setProjects);

    return () => {
      offRegistry();
      client.close();
      clientRef.current = null;
    };
  }, []);

  function pin(path: string, opts?: { displayName?: string; uiPrefs?: unknown }): void {
    clientRef.current?.pin(path, opts);
  }

  function unpin(path: string): void {
    clientRef.current?.unpin(path);
  }

  return { projects, pin, unpin };
}
