import { useRef, useEffect, useReducer, useCallback } from "react";
import { detectAccess, type AccessMap } from "./access-detector.js";
import type { SharedChatRegistry } from "../ui/streaming/registry.js";

function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    ) {
      return false;
    }
  }
  return true;
}

export function useSmartSubscription<
  TState extends Record<string, unknown>,
  TSnapshot extends Record<string, unknown>,
  TSelected,
>(
  registry: SharedChatRegistry<TState>,
  selector: ((snapshot: TSnapshot) => TSelected) | undefined,
  getSnapshot: () => TSnapshot
): TSelected extends undefined ? TSnapshot : TSelected {
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const accessMapRef = useRef<AccessMap | null>(null);
  const selectorRef = useRef(selector);
  const lastSelectedRef = useRef<TSelected | TSnapshot | null>(null);

  if (selectorRef.current !== selector) {
    selectorRef.current = selector;
    accessMapRef.current = null;
  }

  if (selector && !accessMapRef.current) {
    const snapshot = getSnapshot();
    accessMapRef.current = detectAccess(
      selector as (s: Record<string, unknown>) => unknown,
      snapshot as Record<string, unknown>
    );
  }

  const checkForUpdates = useCallback(() => {
    const snapshot = getSnapshot();
    const newSelected = selector ? selector(snapshot) : snapshot;

    if (!shallowEqual(lastSelectedRef.current, newSelected)) {
      lastSelectedRef.current = newSelected;
      forceRender();
    }
  }, [getSnapshot, selector]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    if (!selector) {
      unsubs.push(registry.registerStateCallback(checkForUpdates));
      unsubs.push(registry.registerMessagesCallback(checkForUpdates));
      unsubs.push(registry.registerToolsCallback(checkForUpdates));
      unsubs.push(registry.registerErrorCallback(checkForUpdates));
      unsubs.push(registry.registerIsLoadingCallback(checkForUpdates));
      unsubs.push(registry.registerIsHistoryLoadingCallback(checkForUpdates));
      unsubs.push(registry.registerStreamCallback(checkForUpdates));
      return () => unsubs.forEach((fn) => fn());
    }

    const accessed = accessMapRef.current!;

    if (accessed.uiMessages) {
      unsubs.push(registry.registerMessagesCallback(checkForUpdates));
    }

    if (accessed.tools) {
      unsubs.push(registry.registerToolsCallback(checkForUpdates));
    }

    if (accessed.error) {
      unsubs.push(registry.registerErrorCallback(checkForUpdates));
    }

    if (accessed.isLoading) {
      unsubs.push(registry.registerIsLoadingCallback(checkForUpdates));
    }

    if (accessed.isThreadLoading) {
      unsubs.push(registry.registerIsHistoryLoadingCallback(checkForUpdates));
    }

    if (accessed.state) {
      if (accessed.stateKeys.size > 0) {
        for (const key of accessed.stateKeys) {
          unsubs.push(registry.registerStateKeyCallback(key, checkForUpdates));
        }
      } else {
        unsubs.push(registry.registerStateCallback(checkForUpdates));
      }
    }

    if (accessed.values || accessed.messages || accessed.history || accessed.branch || accessed.interrupt) {
      unsubs.push(registry.registerStreamCallback(checkForUpdates));
    }

    return () => unsubs.forEach((fn) => fn());
  }, [registry, selector, checkForUpdates]);

  const snapshot = getSnapshot();
  const result = selector ? selector(snapshot) : snapshot;
  lastSelectedRef.current = result;

  return result as TSelected extends undefined ? TSnapshot : TSelected;
}
