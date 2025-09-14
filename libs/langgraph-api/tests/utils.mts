import { vi } from 'vitest';
import type { PersistenceType } from '../src/storage/config.mts';
import { randomUUID } from "crypto";
import type { AuthContext } from "../src/auth/index.mjs";
import { Assistants, Threads } from "../src/storage/ops.mjs";
import type { RunKwargs } from "../src/storage/types/run.mjs";

export type QueueType = "memory" | "redis";
export const QueueTypes: QueueType[] = ["memory", "redis"];

export async function gatherIterator<T>(
  i: AsyncIterable<T> | Promise<AsyncIterable<T>>,
): Promise<Array<T>> {
  const out: T[] = [];
  for await (const item of await i) out.push(item);
  return out;
}

export function findLast<T, S extends T>(
  lst: Array<T>,
  predicate: (item: T) => item is S,
): S | undefined {
  for (let i = lst.length - 1; i >= 0; i--) {
    if (predicate(lst[i])) return lst[i] as S;
  }
  return undefined;
}

export async function truncate(
  apiUrl: string,
  options:
    | {
        runs?: boolean;
        threads?: boolean;
        assistants?: boolean;
        store?: boolean;
        checkpoint?: boolean;
      }
    | "all",
) {
  const flags =
    options === "all"
      ? {
          runs: true,
          threads: true,
          assistants: true,
          store: true,
          checkpoint: true,
          full: true,
        }
      : options;

  await fetch(`${apiUrl}/internal/truncate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flags),
  });
}

export const mockPostgresConfig = {
  PERSISTENCE_TYPE: "postgres",
  POSTGRES_URI_CUSTOM: "postgresql://postgres:postgres@localhost:5432/testdb",
  LANGGRAPH_POSTGRES_MAX_POOL_SIZE: 150,
  POSTGRES_SCHEMA: "public",
}

export const mockMemoryConfig = {
  PERSISTENCE_TYPE: "memory",
}

export const mockRedisQueueConfig = {
  REDIS_URI_CUSTOM: "redis://localhost:6379",
}

export const mockMemoryQueueConfig = {
  // No Redis URI set, so it defaults to memory
}

export const mockPersistenceConfig = {
  "postgres": mockPostgresConfig,
  "memory": mockMemoryConfig
}

export const mockQueueConfig = {
  "redis": mockRedisQueueConfig,
  "memory": mockMemoryQueueConfig
}

export const stubPersistence = (persistenceType: PersistenceType) => {
  const config = mockPersistenceConfig[persistenceType];
  vi.unstubAllEnvs();

  Object.entries(config).forEach(([key, value]) => {
    vi.stubEnv(key, String(value));
  });
}

export const stubQueue = (queueType: QueueType) => {
  const config = mockQueueConfig[queueType];
  
  // Clear Redis-related env vars first
  vi.stubEnv('REDIS_URI_CUSTOM', '');
  
  Object.entries(config).forEach(([key, value]) => {
    vi.stubEnv(key, String(value));
  });
}

export const authorizedUserContext: AuthContext = {
    user: {
        identity: "user123",
        permissions: ["threads:create_run", "threads:read", "threads:update", "threads:delete",
                      "assistants:create", "assistants:read", "assistants:search"],
        display_name: "John Doe",
        is_authenticated: true,
    },
    scopes: ["threads:write", "threads:read", "threads:create_run", "threads:update", "threads:delete", "threads:search",
              "assistants:write", "assistants:create", "assistants:read", "assistants:search"],
};

export const differentUserContext: AuthContext = {
    user: {
        identity: "user456",
        permissions: ["threads:read"],
        display_name: "Jane Smith",
        is_authenticated: true,
    },
    scopes: ["threads:read"],
};

// Helper function to create a test assistant
export const createTestAssistant = async (auth?: AuthContext) => {
    const assistantId = randomUUID();
    await Assistants.put(assistantId, {
        config: { configurable: { test: "value" } },
        graph_id: "test-graph-123",
        metadata: { owner: auth?.user?.identity || "system" },
        if_exists: "raise"
    }, auth);
    return assistantId;
};

// Helper function to create a test thread
export const createTestThread = async (auth?: AuthContext) => {
    const threadId = randomUUID();
    await Threads.put(threadId, {
        metadata: { owner: auth?.user?.identity || "system" },
        if_exists: "raise"
    }, auth);
    return threadId;
};

// Helper function to create test run kwargs
export const createTestRunKwargs = (): RunKwargs => ({
    input: { message: "test input" },
    config: { configurable: { test_param: "test_value" } },
    stream_mode: ["values"],
    subgraphs: false,
    resumable: false,
    temporary: false
});
