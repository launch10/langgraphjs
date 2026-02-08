/**
 * Raw Events Stream Integration Tests
 *
 * Tests the `stream_mode: ["raw_events"]` feature that streams every
 * graph.streamEvents() event unfiltered over SSE. This enables the
 * langgraph-ai-sdk to process raw events client-side through its
 * existing handler pipeline (adaptStreamEvents → Handlers).
 *
 * Prerequisites:
 * - Postgres running on localhost:5432
 * - Redis running on localhost:6379 (optional; tests skip if unavailable)
 *
 * Run with: yarn test:int -- tests/raw-events-stream.int.test.ts
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import * as pg from "pg";
import { StateGraph, Annotation } from "@langchain/langgraph";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { HumanMessage } from "@langchain/core/messages";
import { createLangGraphApi, type LangGraphApi } from "../src/app.mjs";
import { poolManager } from "../src/storage/postgres/pool.mjs";
import { clearProgrammaticAuth } from "../src/auth/index.mjs";

const { Pool } = (pg as any).default ?? pg;

const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";

const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

// ─── Test Graph Factories ───────────────────────────────────────────────────

/** Simple graph with string messages for basic streaming */
function createSimpleGraph() {
  const State = Annotation.Root({
    messages: Annotation<string[]>({
      reducer: (curr, update) => [...curr, ...update],
      default: () => [],
    }),
    counter: Annotation<number>({
      reducer: (_curr, update) => update,
      default: () => 0,
    }),
  });

  return new StateGraph(State)
    .addNode("agent", async (state) => ({
      messages: [...state.messages, `step-${state.counter + 1}`],
      counter: state.counter + 1,
    }))
    .addEdge("__start__", "agent")
    .addEdge("agent", "__end__")
    .compile();
}

/** Graph using FakeListChatModel for realistic LLM-style events */
function createChatGraph() {
  const State = Annotation.Root({
    messages: Annotation<any[]>({
      reducer: (curr, update) => [...curr, ...update],
      default: () => [],
    }),
  });

  const model = new FakeListChatModel({
    responses: ["Hello! I am an AI assistant."],
  });

  return new StateGraph(State)
    .addNode("agent", async (state) => {
      const response = await model.invoke(state.messages);
      return { messages: [response] };
    })
    .addEdge("__start__", "agent")
    .addEdge("agent", "__end__")
    .compile();
}

/** Graph that reads configurable values (for auth injection testing) */
function createConfigReadingGraph() {
  const State = Annotation.Root({
    messages: Annotation<string[]>({
      reducer: (curr, update) => [...curr, ...update],
      default: () => [],
    }),
    user_id: Annotation<string>({
      reducer: (_curr, update) => update,
      default: () => "",
    }),
  });

  return new StateGraph(State)
    .addNode("agent", async (state, config) => {
      const userId = (config as any)?.configurable?.user_id ?? "unknown";
      return {
        messages: [`user is ${userId}`],
        user_id: userId,
      };
    })
    .addEdge("__start__", "agent")
    .addEdge("agent", "__end__")
    .compile();
}

// ─── Helper: Check Redis Availability ───────────────────────────────────────

async function isRedisAvailable(): Promise<boolean> {
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url: TEST_REDIS_URL });
    await client.connect();
    await client.ping();
    await client.flushDb();
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}

// ─── Helper: Collect SSE Events ─────────────────────────────────────────────

async function collectSSEEvents(
  response: Response,
  opts?: { maxEvents?: number; timeout?: number }
): Promise<Array<{ event: string; data: string; id?: string }>> {
  const events: Array<{ event: string; data: string; id?: string }> = [];
  const maxEvents = opts?.maxEvents ?? 1000;
  const timeout = opts?.timeout ?? 30000;

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const startTime = Date.now();

  let currentEvent: string | undefined;
  let currentDataLines: string[] = [];
  let currentId: string | undefined;

  const flushEvent = () => {
    if (currentEvent && events.length < maxEvents) {
      events.push({
        event: currentEvent,
        data: currentDataLines.join("\n"),
        id: currentId,
      });
    }
    currentEvent = undefined;
    currentDataLines = [];
    currentId = undefined;
  };

  while (events.length < maxEvents && Date.now() - startTime < timeout) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.substring(7);
      } else if (line.startsWith("data: ")) {
        currentDataLines.push(line.substring(6));
      } else if (line.startsWith("id: ")) {
        currentId = line.substring(4);
      } else if (line.trim() === "") {
        flushEvent();
      }
    }
  }

  flushEvent();

  try {
    reader.cancel();
  } catch {
    // ignore
  }

  return events;
}

// ─── Helper: Create Thread ──────────────────────────────────────────────────

async function createThread(
  app: LangGraphApi["app"],
  headers?: Record<string, string>
): Promise<{ thread_id: string }> {
  const res = await app.request("/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  return res.json();
}

// ─── Helper: Start a Streaming Run ──────────────────────────────────────────

async function startStreamingRun(
  app: LangGraphApi["app"],
  threadId: string,
  opts?: {
    assistantId?: string;
    input?: Record<string, unknown>;
    streamMode?: string[];
    resumable?: boolean;
    headers?: Record<string, string>;
  }
): Promise<Response> {
  return app.request(`/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    body: JSON.stringify({
      assistant_id: opts?.assistantId ?? "test-graph",
      input: opts?.input ?? { messages: ["hello"] },
      stream_mode: opts?.streamMode ?? ["raw_events"],
      stream_resumable: opts?.resumable ?? true,
      multitask_strategy: "reject",
    }),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═════════════════════════════════════════════════════════════════════════════

describe("Raw Events Stream Tests", () => {
  let testDbName: string;
  let testDbUrl: string;
  let redisAvailable: boolean;

  beforeAll(async () => {
    redisAvailable = await isRedisAvailable();
    console.log(`Redis available: ${redisAvailable}`);

    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    testDbName = `lg_rawevents_test_${Date.now()}_${Math.floor(
      Math.random() * 1000
    )}`;

    try {
      await pool.query(`CREATE DATABASE ${testDbName}`);
      console.log(`Created test database: ${testDbName}`);
      testDbUrl = `${TEST_POSTGRES_URL.split("/")
        .slice(0, -1)
        .join("/")}/${testDbName}`;
    } finally {
      await pool.end();
    }
  }, 30000);

  afterEach(() => {
    clearProgrammaticAuth();
  });

  afterAll(async () => {
    await poolManager.shutdown();
    await new Promise((r) => setTimeout(r, 200));

    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${testDbName}'
        AND pid <> pg_backend_pid()
      `);
      await new Promise((r) => setTimeout(r, 100));
      await pool.query(`DROP DATABASE IF EXISTS ${testDbName}`);
      console.log(`Dropped test database: ${testDbName}`);
    } catch (err) {
      console.warn(`Failed to drop test database ${testDbName}:`, err);
    } finally {
      await pool.end();
    }
  }, 30000);

  // ─── Test 1: raw_events yields all StreamEvent types ─────────────────────

  it("raw_events stream produces unfiltered StreamEvent data", async () => {
    const api = await createLangGraphApi({
      postgresUri: testDbUrl,
      redisUrl: redisAvailable ? TEST_REDIS_URL : undefined,
      workers: 2,
    });

    try {
      await api.registerGraph("test-graph", createSimpleGraph());

      const { thread_id } = await createThread(api.app);
      const response = await startStreamingRun(api.app, thread_id, {
        streamMode: ["raw_events"],
      });

      expect(response.status).toBe(200);

      const sseEvents = await collectSSEEvents(response);

      // Should have metadata event
      const metadataEvents = sseEvents.filter((e) => e.event === "metadata");
      expect(metadataEvents.length).toBe(1);

      // Should have raw_events
      const rawEvents = sseEvents.filter((e) => e.event === "raw_events");
      expect(rawEvents.length).toBeGreaterThan(0);

      // Parse raw events and verify structure
      const parsedRawEvents = rawEvents.map((e) => JSON.parse(e.data));

      // Should include on_chain_stream events (root chain)
      const chainStreamEvents = parsedRawEvents.filter(
        (e: any) => e.event === "on_chain_stream"
      );
      expect(chainStreamEvents.length).toBeGreaterThan(0);

      // Should include on_chain_start events
      const chainStartEvents = parsedRawEvents.filter(
        (e: any) => e.event === "on_chain_start"
      );
      expect(chainStartEvents.length).toBeGreaterThan(0);

      // Should include on_chain_end events
      const chainEndEvents = parsedRawEvents.filter(
        (e: any) => e.event === "on_chain_end"
      );
      expect(chainEndEvents.length).toBeGreaterThan(0);

      // Every raw event should have the standard StreamEvent shape
      for (const event of parsedRawEvents) {
        expect(event).toHaveProperty("event");
        expect(event).toHaveProperty("data");
        expect(event).toHaveProperty("run_id");
        expect(typeof event.event).toBe("string");
      }
    } finally {
      await api.cleanup();
    }
  }, 30000);

  // ─── Test 2: raw_events includes mode tuples in on_chain_stream ──────────

  it("raw_events includes messages/updates/custom mode tuples", async () => {
    const api = await createLangGraphApi({
      postgresUri: testDbUrl,
      redisUrl: redisAvailable ? TEST_REDIS_URL : undefined,
      workers: 2,
    });

    try {
      await api.registerGraph("test-graph", createSimpleGraph());

      const { thread_id } = await createThread(api.app);
      const response = await startStreamingRun(api.app, thread_id, {
        streamMode: ["raw_events"],
      });

      const sseEvents = await collectSSEEvents(response);
      const rawEvents = sseEvents.filter((e) => e.event === "raw_events");
      const parsedRawEvents = rawEvents.map((e) => JSON.parse(e.data));

      // Find root on_chain_stream events (they carry mode tuples)
      const rootChainStreams = parsedRawEvents.filter(
        (e: any) => e.event === "on_chain_stream"
      );

      // Extract mode tuples from the chunks
      const modes = new Set<string>();
      for (const event of rootChainStreams) {
        const chunk = event.data?.chunk;
        if (Array.isArray(chunk) && chunk.length >= 2) {
          // Chunk is [mode, data] or [namespace, mode, data]
          const mode = typeof chunk[0] === "string" ? chunk[0] : chunk[1];
          if (typeof mode === "string") {
            modes.add(mode);
          }
        }
      }

      // raw_events mode adds messages, updates, and custom to libStreamMode
      // A simple graph produces at least updates and debug
      expect(modes.has("updates") || modes.has("debug")).toBe(true);
    } finally {
      await api.cleanup();
    }
  }, 30000);

  // ─── Test 3: raw_events coexists with other stream modes ─────────────────

  it("raw_events works alongside other stream modes", async () => {
    const api = await createLangGraphApi({
      postgresUri: testDbUrl,
      redisUrl: redisAvailable ? TEST_REDIS_URL : undefined,
      workers: 2,
    });

    try {
      await api.registerGraph("test-graph", createSimpleGraph());

      const { thread_id } = await createThread(api.app);
      const response = await startStreamingRun(api.app, thread_id, {
        streamMode: ["raw_events", "values"],
      });

      expect(response.status).toBe(200);

      const sseEvents = await collectSSEEvents(response);

      // Should have both raw_events AND values events
      const rawEvents = sseEvents.filter((e) => e.event === "raw_events");
      const valuesEvents = sseEvents.filter((e) => e.event === "values");

      expect(rawEvents.length).toBeGreaterThan(0);
      expect(valuesEvents.length).toBeGreaterThan(0);
    } finally {
      await api.cleanup();
    }
  }, 30000);

  // ─── Test 4: raw_events with FakeListChatModel produces chat events ──────

  it("raw_events produces on_chat_model events with FakeListChatModel", async () => {
    const api = await createLangGraphApi({
      postgresUri: testDbUrl,
      redisUrl: redisAvailable ? TEST_REDIS_URL : undefined,
      workers: 2,
    });

    try {
      await api.registerGraph("chat-graph", createChatGraph());

      const { thread_id } = await createThread(api.app);
      const response = await startStreamingRun(api.app, thread_id, {
        assistantId: "chat-graph",
        input: { messages: [new HumanMessage("hi")] },
        streamMode: ["raw_events"],
      });

      expect(response.status).toBe(200);

      const sseEvents = await collectSSEEvents(response);
      const rawEvents = sseEvents.filter((e) => e.event === "raw_events");
      const parsedRawEvents = rawEvents.map((e) => JSON.parse(e.data));

      // Should have chat model events (start, stream, end)
      const chatModelEvents = parsedRawEvents.filter(
        (e: any) =>
          e.event === "on_chat_model_start" ||
          e.event === "on_chat_model_stream" ||
          e.event === "on_chat_model_end"
      );

      // FakeListChatModel should produce at least start + end events
      expect(chatModelEvents.length).toBeGreaterThanOrEqual(2);

      // Verify chat model end has output data
      const chatModelEnd = parsedRawEvents.find(
        (e: any) => e.event === "on_chat_model_end"
      );
      expect(chatModelEnd).toBeDefined();
      expect(chatModelEnd.data).toBeDefined();
    } finally {
      await api.cleanup();
    }
  }, 30000);

  // ─── Test 5: onRunComplete still fires with raw_events ───────────────────

  it("onRunComplete receives checkpoint with raw_events mode", async () => {
    let hookCalled = false;
    let hookCheckpoint: any = undefined;
    let hookStatus: string | undefined = undefined;

    const api = await createLangGraphApi({
      postgresUri: testDbUrl,
      redisUrl: redisAvailable ? TEST_REDIS_URL : undefined,
      workers: 2,
      onRunComplete: async (_run, result) => {
        hookCalled = true;
        hookCheckpoint = result.checkpoint;
        hookStatus = result.status;
      },
    });

    try {
      await api.registerGraph("test-graph", createSimpleGraph());

      const { thread_id } = await createThread(api.app);
      const response = await startStreamingRun(api.app, thread_id, {
        streamMode: ["raw_events"],
      });

      // Consume the stream to completion
      await collectSSEEvents(response);

      // Wait for hook
      await new Promise((r) => setTimeout(r, 500));

      expect(hookCalled).toBe(true);
      expect(hookStatus).toBe("success");
      expect(hookCheckpoint).toBeDefined();
    } finally {
      await api.cleanup();
    }
  }, 30000);

  // ─── Test 6: Auth + configurable injection with raw_events ───────────────

  it("auth-injected configurable values are available with raw_events", async () => {
    await poolManager.shutdown();

    const api = await createLangGraphApi({
      postgresUri: testDbUrl,
      redisUrl: redisAvailable ? TEST_REDIS_URL : undefined,
      workers: 2,
      auth: {
        authenticate: async (request: Request) => {
          const authHeader = request.headers.get("Authorization");
          if (!authHeader?.startsWith("Bearer ")) {
            throw new Error("Missing token");
          }
          const token = authHeader.substring(7);
          if (token !== "test-token") {
            throw new Error("Invalid token");
          }
          return { identity: "test-user-123" };
        },
        authorize: async (context: any) => {
          // Only inject configurable for run creation (not thread creation)
          if (context.value && "config" in context.value || context.value?.assistant_id) {
            context.value.config = context.value.config ?? {};
            context.value.config.configurable =
              context.value.config.configurable ?? {};
            context.value.config.configurable.user_id =
              context.user.identity;
          }
        },
      },
    });

    try {
      await api.registerGraph("config-graph", createConfigReadingGraph());

      const authHeaders = { Authorization: "Bearer test-token" };

      const { thread_id } = await createThread(api.app, authHeaders);
      const response = await startStreamingRun(api.app, thread_id, {
        assistantId: "config-graph",
        streamMode: ["raw_events", "values"],
        headers: authHeaders,
      });

      expect(response.status).toBe(200);

      const sseEvents = await collectSSEEvents(response);

      // Check that values events contain the auth-injected user_id
      const valuesEvents = sseEvents.filter((e) => e.event === "values");
      expect(valuesEvents.length).toBeGreaterThan(0);

      // The final values event should have the user_id from configurable
      const lastValues = JSON.parse(
        valuesEvents[valuesEvents.length - 1].data
      );
      expect(lastValues.user_id).toBe("test-user-123");
    } finally {
      await api.cleanup();
      await poolManager.shutdown();
    }
  }, 30000);

  // ─── Test 7: raw_events JSON is valid and parseable ──────────────────────

  it("all raw_events data is valid JSON with expected fields", async () => {
    const api = await createLangGraphApi({
      postgresUri: testDbUrl,
      redisUrl: redisAvailable ? TEST_REDIS_URL : undefined,
      workers: 2,
    });

    try {
      await api.registerGraph("test-graph", createSimpleGraph());

      const { thread_id } = await createThread(api.app);
      const response = await startStreamingRun(api.app, thread_id, {
        streamMode: ["raw_events"],
      });

      const sseEvents = await collectSSEEvents(response);
      const rawEvents = sseEvents.filter((e) => e.event === "raw_events");

      for (const rawEvent of rawEvents) {
        // Every raw event data must be valid JSON
        let parsed: any;
        expect(() => {
          parsed = JSON.parse(rawEvent.data);
        }).not.toThrow();

        // Must have the standard StreamEvent fields
        expect(parsed).toHaveProperty("event");
        expect(parsed).toHaveProperty("name");
        expect(parsed).toHaveProperty("data");
        expect(parsed).toHaveProperty("run_id");
        expect(typeof parsed.event).toBe("string");
        expect(typeof parsed.name).toBe("string");
        expect(typeof parsed.run_id).toBe("string");
      }
    } finally {
      await api.cleanup();
    }
  }, 30000);
});
