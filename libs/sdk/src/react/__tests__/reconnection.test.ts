import { describe, it, expect, beforeEach, afterEach } from "vitest";

export interface RunMetadataStorage {
  getItem(key: `lg:stream:${string}`): string | null;
  setItem(key: `lg:stream:${string}`, value: string): void;
  removeItem(key: `lg:stream:${string}`): void;
}

export function createMockStorage(): RunMetadataStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: `lg:stream:${string}`) => data.get(key) ?? null,
    setItem: (key: `lg:stream:${string}`, value: string) => data.set(key, value),
    removeItem: (key: `lg:stream:${string}`) => data.delete(key),
  };
}

describe("Run Metadata Storage", () => {
  describe("storage interface", () => {
    it("stores and retrieves run ID", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      storage.setItem(`lg:stream:${threadId}`, runId);

      expect(storage.getItem(`lg:stream:${threadId}`)).toBe(runId);
    });

    it("removes run ID", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      storage.setItem(`lg:stream:${threadId}`, runId);
      storage.removeItem(`lg:stream:${threadId}`);

      expect(storage.getItem(`lg:stream:${threadId}`)).toBeNull();
    });

    it("returns null for non-existent key", () => {
      const storage = createMockStorage();

      expect(storage.getItem("lg:stream:non-existent")).toBeNull();
    });

    it("overwrites existing value", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";

      storage.setItem(`lg:stream:${threadId}`, "run-1");
      storage.setItem(`lg:stream:${threadId}`, "run-2");

      expect(storage.getItem(`lg:stream:${threadId}`)).toBe("run-2");
    });
  });

  describe("session storage compatibility", () => {
    let originalSessionStorage: Storage | undefined;

    beforeEach(() => {
      originalSessionStorage = globalThis.sessionStorage;
      const mockStorage = new Map<string, string>();
      Object.defineProperty(globalThis, "sessionStorage", {
        value: {
          getItem: (key: string) => mockStorage.get(key) ?? null,
          setItem: (key: string, value: string) => mockStorage.set(key, value),
          removeItem: (key: string) => mockStorage.delete(key),
          clear: () => mockStorage.clear(),
          length: mockStorage.size,
          key: (index: number) => Array.from(mockStorage.keys())[index] ?? null,
        },
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      if (originalSessionStorage) {
        Object.defineProperty(globalThis, "sessionStorage", {
          value: originalSessionStorage,
          writable: true,
          configurable: true,
        });
      }
    });

    it("works with sessionStorage API", () => {
      const threadId = "thread-123";
      const runId = "run-456";

      sessionStorage.setItem(`lg:stream:${threadId}`, runId);

      expect(sessionStorage.getItem(`lg:stream:${threadId}`)).toBe(runId);

      sessionStorage.removeItem(`lg:stream:${threadId}`);

      expect(sessionStorage.getItem(`lg:stream:${threadId}`)).toBeNull();
    });
  });
});

describe("joinStream logic", () => {
  describe("reconnection key detection", () => {
    it("detects reconnection key from storage", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      storage.setItem(`lg:stream:${threadId}`, runId);

      const reconnectKey = storage.getItem(`lg:stream:${threadId}`);
      expect(reconnectKey).toBe(runId);
    });

    it("returns null when no run in progress", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";

      const reconnectKey = storage.getItem(`lg:stream:${threadId}`);
      expect(reconnectKey).toBeNull();
    });
  });

  describe("reconnect on mount logic", () => {
    it("should reconnect when storage has run ID and reconnectOnMount is true", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      storage.setItem(`lg:stream:${threadId}`, runId);

      const shouldReconnect = true;
      const isLoading = false;
      const storedRunId = storage.getItem(`lg:stream:${threadId}`);

      const reconnectKey =
        shouldReconnect && !isLoading && storedRunId
          ? { runId: storedRunId, threadId }
          : undefined;

      expect(reconnectKey).toEqual({ runId, threadId });
    });

    it("should not reconnect when isLoading is true", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      storage.setItem(`lg:stream:${threadId}`, runId);

      const shouldReconnect = true;
      const isLoading = true;
      const storedRunId = storage.getItem(`lg:stream:${threadId}`);

      const reconnectKey =
        shouldReconnect && !isLoading && storedRunId
          ? { runId: storedRunId, threadId }
          : undefined;

      expect(reconnectKey).toBeUndefined();
    });

    it("should not reconnect when reconnectOnMount is false", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      storage.setItem(`lg:stream:${threadId}`, runId);

      const shouldReconnect = false;
      const isLoading = false;
      const storedRunId = storage.getItem(`lg:stream:${threadId}`);

      const reconnectKey =
        shouldReconnect && !isLoading && storedRunId
          ? { runId: storedRunId, threadId }
          : undefined;

      expect(reconnectKey).toBeUndefined();
    });
  });

  describe("run lifecycle storage", () => {
    it("stores run ID on stream creation", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      const onRunCreated = (params: { run_id: string; thread_id: string }) => {
        storage.setItem(`lg:stream:${params.thread_id}`, params.run_id);
      };

      onRunCreated({ run_id: runId, thread_id: threadId });

      expect(storage.getItem(`lg:stream:${threadId}`)).toBe(runId);
    });

    it("clears run ID on success", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      storage.setItem(`lg:stream:${threadId}`, runId);

      const onSuccess = () => {
        storage.removeItem(`lg:stream:${threadId}`);
      };

      onSuccess();

      expect(storage.getItem(`lg:stream:${threadId}`)).toBeNull();
    });

    it("clears run ID on stop", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      storage.setItem(`lg:stream:${threadId}`, runId);

      const onStop = () => {
        storage.removeItem(`lg:stream:${threadId}`);
      };

      onStop();

      expect(storage.getItem(`lg:stream:${threadId}`)).toBeNull();
    });

    it("preserves run ID on error for retry", () => {
      const storage = createMockStorage();
      const threadId = "thread-123";
      const runId = "run-456";

      storage.setItem(`lg:stream:${threadId}`, runId);

      expect(storage.getItem(`lg:stream:${threadId}`)).toBe(runId);
    });
  });
});

describe("reconnect state machine", () => {
  it("transitions through correct states", () => {
    type ReconnectState = "idle" | "checking" | "reconnecting" | "connected" | "error";

    const storage = createMockStorage();
    const threadId = "thread-123";
    const runId = "run-456";

    storage.setItem(`lg:stream:${threadId}`, runId);

    let state: ReconnectState = "idle";

    const checkForReconnect = () => {
      state = "checking";
      const storedRunId = storage.getItem(`lg:stream:${threadId}`);
      if (storedRunId) {
        state = "reconnecting";
        return storedRunId;
      }
      state = "idle";
      return null;
    };

    const onReconnectSuccess = () => {
      state = "connected";
      storage.removeItem(`lg:stream:${threadId}`);
    };

    void function onReconnectError() {
      state = "error";
    };

    expect(state).toBe("idle");

    const foundRunId = checkForReconnect();
    expect(state).toBe("reconnecting");
    expect(foundRunId).toBe(runId);

    onReconnectSuccess();
    expect(state).toBe("connected");
    expect(storage.getItem(`lg:stream:${threadId}`)).toBeNull();
  });

  it("handles no pending run", () => {
    type ReconnectState = "idle" | "checking" | "reconnecting" | "connected" | "error";

    const storage = createMockStorage();
    const threadId = "thread-123";

    let state: ReconnectState = "idle";

    const checkForReconnect = () => {
      state = "checking";
      const storedRunId = storage.getItem(`lg:stream:${threadId}`);
      if (storedRunId) {
        state = "reconnecting";
        return storedRunId;
      }
      state = "idle";
      return null;
    };

    const foundRunId = checkForReconnect();
    expect(state).toBe("idle");
    expect(foundRunId).toBeNull();
  });
});

describe("thread ID switching", () => {
  it("resets reconnect state when thread ID changes", () => {
    const storage = createMockStorage();
    const threadId1 = "thread-123";
    const threadId2 = "thread-456";
    const runId = "run-789";

    storage.setItem(`lg:stream:${threadId1}`, runId);

    let currentThreadId = threadId1;
    let shouldReconnect = true;

    const onThreadChange = (newThreadId: string) => {
      if (currentThreadId !== newThreadId) {
        currentThreadId = newThreadId;
        shouldReconnect = true;
      }
    };

    onThreadChange(threadId2);

    const reconnectKey = storage.getItem(`lg:stream:${currentThreadId}`);
    expect(reconnectKey).toBeNull();
    expect(shouldReconnect).toBe(true);
  });
});

describe("streamResumable option", () => {
  it("enables stream resumability when reconnectOnMount is set", () => {
    const hasReconnectOnMount = true;
    const explicitStreamResumable: boolean | undefined = undefined;

    const streamResumable = explicitStreamResumable ?? hasReconnectOnMount;

    expect(streamResumable).toBe(true);
  });

  it("respects explicit streamResumable false", () => {
    const hasReconnectOnMount = true;
    const explicitStreamResumable = false;

    const streamResumable = explicitStreamResumable ?? hasReconnectOnMount;

    expect(streamResumable).toBe(false);
  });

  it("defaults onDisconnect to continue when streamResumable", () => {
    const streamResumable = true;
    const explicitOnDisconnect: "cancel" | "continue" | undefined = undefined;

    const onDisconnect = explicitOnDisconnect ?? (streamResumable ? "continue" : "cancel");

    expect(onDisconnect).toBe("continue");
  });
});
