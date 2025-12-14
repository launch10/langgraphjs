export type AccessMap = {
  messages: boolean;
  status: boolean;
  error: boolean;
  state: boolean;
  stateKeys: Set<string>;
  tools: boolean;
  uiMessages: boolean;
  isLoading: boolean;
  threadId: boolean;
  branch: boolean;
  history: boolean;
  values: boolean;
  interrupt: boolean;
};

const REACTIVE_KEYS = new Set([
  "messages",
  "status",
  "error",
  "state",
  "tools",
  "uiMessages",
  "isLoading",
  "threadId",
  "branch",
  "history",
  "values",
  "interrupt",
]);

function createStateProxy<TState extends Record<string, unknown>>(
  target: TState,
  map: AccessMap
): TState {
  return new Proxy(target ?? {}, {
    get(obj, prop: string) {
      if (typeof prop === "string") {
        map.stateKeys.add(prop);
      }
      return (obj as Record<string, unknown>)[prop];
    },
  }) as TState;
}

export function createTrackingProxy<TSnapshot extends Record<string, unknown>>(
  target: TSnapshot,
  map: AccessMap
): TSnapshot {
  return new Proxy(target, {
    get(obj, prop: string) {
      const value = obj[prop];
      if (typeof value === "function") return value;

      if (REACTIVE_KEYS.has(prop)) {
        if (prop === "state") {
          Object.assign(map, { state: true });
          return createStateProxy(
            value as Record<string, unknown>,
            map
          );
        }
        Object.assign(map, { [prop]: true });
      }
      return value;
    },
  }) as TSnapshot;
}

export function createEmptyAccessMap(): AccessMap {
  return {
    messages: false,
    status: false,
    error: false,
    state: false,
    stateKeys: new Set(),
    tools: false,
    uiMessages: false,
    isLoading: false,
    threadId: false,
    branch: false,
    history: false,
    values: false,
    interrupt: false,
  };
}

export function detectAccess<
  TSnapshot extends Record<string, unknown>,
  TSelected,
>(
  selector: (snapshot: TSnapshot) => TSelected,
  snapshot: TSnapshot
): AccessMap {
  const accessMap = createEmptyAccessMap();
  const proxy = createTrackingProxy(snapshot, accessMap);
  try {
    selector(proxy);
  } catch {
    // Ignore errors during access detection
  }
  return accessMap;
}
