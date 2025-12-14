export type AccessMap = {
  messages: boolean;
  values: boolean;
  error: boolean;
  state: boolean;
  stateKeys: Set<string>;
  tools: boolean;
  uiMessages: boolean;
  isLoading: boolean;
  isThreadLoading: boolean;
  branch: boolean;
  history: boolean;
  interrupt: boolean;
};

export function createEmptyAccessMap(): AccessMap {
  return {
    messages: false,
    values: false,
    error: false,
    state: false,
    stateKeys: new Set(),
    tools: false,
    uiMessages: false,
    isLoading: false,
    isThreadLoading: false,
    branch: false,
    history: false,
    interrupt: false,
  };
}

const REACTIVE_KEYS = new Set([
  "messages",
  "values",
  "error",
  "state",
  "tools",
  "uiMessages",
  "isLoading",
  "isThreadLoading",
  "branch",
  "history",
  "interrupt",
]);

function createStateProxy<TState extends Record<string, unknown>>(
  target: TState,
  accessMap: AccessMap
): TState {
  return new Proxy(target ?? {}, {
    get(obj, prop: string) {
      if (typeof prop === "string") {
        accessMap.stateKeys.add(prop);
      }
      return (obj as Record<string, unknown>)[prop];
    },
  }) as TState;
}

export function createTrackingProxy<TSnapshot extends Record<string, unknown>>(
  target: TSnapshot,
  accessMap: AccessMap
): TSnapshot {
  return new Proxy(target, {
    get(obj, prop: string) {
      const value = obj[prop];

      if (typeof value === "function") {
        return value;
      }

      if (REACTIVE_KEYS.has(prop)) {
        if (prop === "state") {
          accessMap.state = true;
          return createStateProxy(value as Record<string, unknown>, accessMap);
        }
        (accessMap as Record<string, boolean>)[prop] = true;
      }

      return value;
    },
  }) as TSnapshot;
}

export function detectAccess<TSnapshot extends Record<string, unknown>, TSelected>(
  selector: (snapshot: TSnapshot) => TSelected,
  snapshot: TSnapshot
): AccessMap {
  const accessMap = createEmptyAccessMap();
  const proxy = createTrackingProxy(snapshot, accessMap);

  try {
    selector(proxy);
  } catch {
  }

  return accessMap;
}
