import { useMemo, useEffect, useSyncExternalStore, useCallback } from "react";
import { SharedChatRegistry } from "../ui/streaming/registry.js";

export interface UseStreamUIStateOptions<TState, K extends keyof TState> {
  apiUrl: string;
  threadId?: string;
  key: K;
}

export function useStreamUIState<
  TState extends Record<string, unknown>,
  K extends keyof TState,
>(options: UseStreamUIStateOptions<TState, K>): TState[K] | undefined {
  const { apiUrl, threadId, key } = options;

  const registry = useMemo(
    () =>
      SharedChatRegistry.getOrCreate<TState>({
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
    return registry.getState()[key];
  }, [registry, key]);

  const subscribe = useCallback(
    (cb: () => void) => registry.subscribeState(cb),
    [registry]
  );

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return value;
}
