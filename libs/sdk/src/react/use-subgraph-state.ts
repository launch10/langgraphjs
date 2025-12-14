import { useMemo, useEffect, useSyncExternalStore, useCallback } from "react";
import { SharedChatRegistry } from "../ui/streaming/registry.js";

export interface UseSubgraphStateOptions {
  apiUrl: string;
  threadId?: string;
  namespace: string[];
}

export function useSubgraphState<TState extends Record<string, unknown>>(
  options: UseSubgraphStateOptions
): Partial<TState> | undefined {
  const { apiUrl, threadId, namespace } = options;

  const registry = useMemo(
    () =>
      SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl,
        threadId,
      }),
    [apiUrl, threadId]
  );

  useEffect(() => {
    SharedChatRegistry.acquire(registry);
    return () => SharedChatRegistry.release(registry);
  }, [registry]);

  const getSnapshot = useCallback(() => {
    return registry.getSubgraphState(namespace) as Partial<TState> | undefined;
  }, [registry, namespace]);

  const subscribe = useCallback(
    (cb: () => void) => registry.subscribeState(cb),
    [registry]
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return state;
}
