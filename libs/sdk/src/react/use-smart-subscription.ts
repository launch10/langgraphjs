import { useRef, useEffect, useReducer, useCallback } from "react";
import { detectAccess, type AccessMap } from "./access-detector.js";

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
  TSnapshot extends Record<string, unknown>,
  TSelected,
>(
  getSnapshot: () => TSnapshot,
  selector?: (snapshot: TSnapshot) => TSelected,
  subscribe?: (callback: () => void) => () => void
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
    accessMapRef.current = detectAccess(selector, snapshot);
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
    if (!subscribe) return;
    return subscribe(checkForUpdates);
  }, [subscribe, checkForUpdates]);

  const snapshot = getSnapshot();
  const result = selector ? selector(snapshot) : snapshot;
  lastSelectedRef.current = result;

  return result as TSelected extends undefined ? TSnapshot : TSelected;
}
