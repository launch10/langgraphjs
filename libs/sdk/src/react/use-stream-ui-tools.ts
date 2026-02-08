import { useMemo, useEffect, useSyncExternalStore, useCallback } from "react";
import { SharedChatRegistry } from "../ui/streaming/registry.js";
import type { ToolState } from "../ui/streaming/types.js";

export interface UseStreamUIToolsOptions {
  apiUrl: string;
  threadId?: string;
}

export function useStreamUITools(options: UseStreamUIToolsOptions): ToolState[] {
  const { apiUrl, threadId } = options;

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

  const getSnapshot = useCallback(() => registry.getTools(), [registry]);

  const subscribe = useCallback(
    (cb: () => void) => registry.subscribeTools(cb),
    [registry]
  );

  const tools = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return tools;
}
