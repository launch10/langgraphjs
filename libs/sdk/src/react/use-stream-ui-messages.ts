import { useMemo, useEffect, useSyncExternalStore, useCallback } from "react";
import { SharedChatRegistry } from "../ui/streaming/registry.js";
import type { MessageWithBlocks } from "../ui/streaming/types.js";

export interface UseStreamUIMessagesOptions {
  apiUrl: string;
  threadId?: string;
}

export function useStreamUIMessages<TSchema = unknown>(
  options: UseStreamUIMessagesOptions
): MessageWithBlocks<TSchema>[] {
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

  const getSnapshot = useCallback(
    () => registry.getMessages() as MessageWithBlocks<TSchema>[],
    [registry]
  );

  const subscribe = useCallback(
    (cb: () => void) => registry.subscribeMessages(cb),
    [registry]
  );

  const messages = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return messages;
}
