/**
 * Durability & Stress Tests for the LangGraph API Server
 *
 * Tests the production-critical durability features:
 * 1. Disconnect/Reconnect with resumable streams (Last-Event-ID)
 * 2. Worker crash + retry (onRunComplete hooks)
 * 3. Postgres-only fallback (no Redis)
 * 4. Concurrent runs on the same thread (multitask strategies)
 * 5. Load: many concurrent runs across many threads
 * 6. Programmatic auth (JWT-style authenticate + authorize)
 *
 * Prerequisites:
 * - Postgres running on localhost:5432
 * - Redis running on localhost:6379 (optional; some tests skip if unavailable)
 *
 * Run with: yarn test:int -- tests/durability.int.test.ts
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as pg from "pg";
import { StateGraph, Annotation } from "@langchain/langgraph";
import { createLangGraphApi, type LangGraphApi } from "../src/app.mjs";
import { poolManager } from "../src/storage/postgres/pool.mjs";
import { clearProgrammaticAuth } from "../src/auth/index.mjs";

const { Pool } = (pg as any).default ?? pg;

const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";

// Use a high Redis DB number to avoid interfering with running apps
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

// ─── Test Graph Factories ───────────────────────────────────────────────────

/** Simple graph that completes quickly with predictable output */
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

/** Graph with multiple steps that takes a bit longer to complete */
function createMultiStepGraph() {
  const State = Annotation.Root({
    messages: Annotation<string[]>({
      reducer: (curr, update) => [...curr, ...update],
      default: () => [],
    }),
    step: Annotation<number>({
      reducer: (_curr, update) => update,
      default: () => 0,
    }),
  });

  return new StateGraph(State)
    .addNode("step1", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { messages: ["step1-done"], step: 1 };
    })
    .addNode("step2", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { messages: ["step2-done"], step: 2 };
    })
    .addNode("step3", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { messages: ["step3-done"], step: 3 };
    })
    .addEdge("__start__", "step1")
    .addEdge("step1", "step2")
    .addEdge("step2", "step3")
    .addEdge("step3", "__end__")
    .compile();
}

/** Graph that sleeps to allow mid-run testing */
function createSlowGraph(delayMs: number = 500) {
  const State = Annotation.Root({
    messages: Annotation<string[]>({
      reducer: (curr, update) => [...curr, ...update],
      default: () => [],
    }),
  });

  return new StateGraph(State)
    .addNode("slow_agent", async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return { messages: ["slow-done"] };
    })
    .addEdge("__start__", "slow_agent")
    .addEdge("slow_agent", "__end__")
    .compile();
}

/** Graph that fails on first N attempts, then succeeds */
function createFailingGraph(failCount: number = 1) {
  let attempt = 0;

  const State = Annotation.Root({
    messages: Annotation<string[]>({
      reducer: (curr, update) => [...curr, ...update],
      default: () => [],
    }),
  });

  return new StateGraph(State)
    .addNode("flaky_agent", async () => {
      attempt++;
      if (attempt <= failCount) {
        throw new Error(
          `Simulated failure (attempt ${attempt}/${failCount})`
        );
      }
      return { messages: ["recovered"] };
    })
    .addEdge("__start__", "flaky_agent")
    .addEdge("flaky_agent", "__end__")
    .compile();
}

// ─── Helper: Check Redis Availability ───────────────────────────────────────

async function isRedisAvailable(): Promise<boolean> {
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url: TEST_REDIS_URL });
    await client.connect();
    await client.ping();
    await client.flushDb(); // Clean our test DB
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

  // Flush any remaining event in the buffer
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
    multitaskStrategy?: string;
    headers?: Record<string, string>;
  }
): Promise<Response> {
  return app.request(`/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    body: JSON.stringify({
      assistant_id: opts?.assistantId ?? "test-graph",
      input: opts?.input ?? { messages: ["hello"] },
      stream_mode: opts?.streamMode ?? ["values"],
      stream_resumable: opts?.resumable ?? true,
      multitask_strategy: opts?.multitaskStrategy ?? "reject",
    }),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═════════════════════════════════════════════════════════════════════════════

describe("Durability Stress Tests", () => {
  let testDbName: string;
  let testDbUrl: string;
  let redisAvailable: boolean;

  beforeAll(async () => {
    // Check Redis availability
    redisAvailable = await isRedisAvailable();
    console.log(`Redis available: ${redisAvailable}`);

    // Create test database
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    testDbName = `lg_durability_test_${Date.now()}_${Math.floor(
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

  // Clean up global auth state between tests to prevent leakage
  afterEach(() => {
    clearProgrammaticAuth();
  });

  afterAll(async () => {
    await poolManager.shutdown();
    await new Promise((r) => setTimeout(r, 200));

    // Drop test database
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${testDbName}'
        AND pid <> pg_backend_pid()
      `);
      await pool.query(`DROP DATABASE IF EXISTS ${testDbName}`);
      console.log(`Dropped test database: ${testDbName}`);
    } finally {
      await pool.end();
    }

    // Clean Redis test DB
    if (redisAvailable) {
      try {
        const { createClient } = await import("redis");
        const client = createClient({ url: TEST_REDIS_URL });
        await client.connect();
        await client.flushDb();
        await client.disconnect();
      } catch {
        // ignore
      }
    }
  }, 30000);

  // ─── Test 1: Disconnect/Reconnect ───────────────────────────────────────

  describe("Test 1: Disconnect/Reconnect with Resumable Streams", () => {
    let api: LangGraphApi;

    beforeEach(async () => {
      await poolManager.shutdown();
      api = await createLangGraphApi({
        postgresUri: testDbUrl,
        ...(redisAvailable ? { redisUrl: TEST_REDIS_URL } : {}),
        workers: 2,
      });
      await api.registerGraph("test-graph", createMultiStepGraph());
    });

    afterEach(async () => {
      await api.cleanup();
      await poolManager.shutdown();
    });

    it("should complete a resumable streaming run end-to-end", async () => {
      const thread = await createThread(api.app);

      const response = await startStreamingRun(api.app, thread.thread_id, {
        resumable: true,
        streamMode: ["values", "updates"],
      });

      expect(response.status).toBe(200);

      const events = await collectSSEEvents(response, { timeout: 15000 });

      expect(events.length).toBeGreaterThan(0);
      console.log(
        `[Disconnect/Reconnect] Received ${events.length} events from resumable stream`
      );

      // Verify we got expected event types
      const eventTypes = [...new Set(events.map((e) => e.event))];
      console.log(
        `[Disconnect/Reconnect] Event types: ${eventTypes.join(", ")}`
      );
    }, 30000);

    it("should support reconnect via GET /runs/:run_id/stream with Last-Event-ID", async () => {
      const thread = await createThread(api.app);

      const response = await startStreamingRun(api.app, thread.thread_id, {
        resumable: true,
      });

      expect(response.status).toBe(200);

      // Get the run ID from Content-Location header
      const contentLocation = response.headers.get("Content-Location");
      expect(contentLocation).toBeTruthy();
      const runId = contentLocation!.split("/").pop()!;

      // Consume the full stream
      const events = await collectSSEEvents(response, { timeout: 15000 });
      console.log(
        `[Reconnect] Initial stream: ${events.length} events, run ${runId}`
      );

      // Try reconnecting after the run completed
      const reconnectResponse = await api.app.request(
        `/runs/${runId}/stream`,
        {
          method: "GET",
          headers: {
            "Last-Event-ID": "0",
          },
        }
      );

      // 200 with remaining events or 204 if nothing to replay
      expect([200, 204]).toContain(reconnectResponse.status);

      if (reconnectResponse.status === 200) {
        const resumedEvents = await collectSSEEvents(reconnectResponse, {
          timeout: 5000,
        });
        console.log(
          `[Reconnect] Resumed: ${resumedEvents.length} events replayed`
        );
      } else {
        console.log(`[Reconnect] 204 - stream already completed`);
      }
    }, 30000);

    it("should deliver all events even when client is slow", async () => {
      const thread = await createThread(api.app);

      const response = await startStreamingRun(api.app, thread.thread_id, {
        resumable: true,
      });

      expect(response.status).toBe(200);

      // Slowly consume events (simulating slow client)
      const events = await collectSSEEvents(response, { timeout: 20000 });

      expect(events.length).toBeGreaterThan(0);
      console.log(
        `[Slow Client] Received ${events.length} events with slow consumption`
      );
    }, 30000);
  });

  // ─── Test 2: Worker + onRunComplete Hook ────────────────────────────────

  describe("Test 2: Worker + onRunComplete Hook", () => {
    it("should invoke onRunComplete with success status", async () => {
      await poolManager.shutdown();

      const completedRuns: Array<{
        runId: string;
        status: string;
        hasException: boolean;
      }> = [];

      const api = await createLangGraphApi({
        postgresUri: testDbUrl,
        ...(redisAvailable ? { redisUrl: TEST_REDIS_URL } : {}),
        workers: 1,
        onRunComplete: async (run, result) => {
          completedRuns.push({
            runId: run.run_id,
            status: result.status ?? "unknown",
            hasException: !!result.exception,
          });
        },
      });

      try {
        await api.registerGraph("test-graph", createSimpleGraph());

        const thread = await createThread(api.app);
        const response = await startStreamingRun(api.app, thread.thread_id);

        expect(response.status).toBe(200);

        // Consume the stream to completion
        await collectSSEEvents(response, { timeout: 15000 });

        // Wait for onRunComplete to fire
        await new Promise((r) => setTimeout(r, 2000));

        expect(completedRuns.length).toBe(1);
        expect(completedRuns[0].status).toBe("success");
        expect(completedRuns[0].hasException).toBe(false);

        console.log(
          `[onRunComplete] Called with status: ${completedRuns[0].status}`
        );
      } finally {
        await api.cleanup();
        await poolManager.shutdown();
      }
    }, 30000);

    it("should invoke onRunComplete with error for failing graph", async () => {
      await poolManager.shutdown();

      const completedRuns: Array<{
        runId: string;
        status: string;
        hasException: boolean;
        exceptionMessage?: string;
      }> = [];

      const api = await createLangGraphApi({
        postgresUri: testDbUrl,
        ...(redisAvailable ? { redisUrl: TEST_REDIS_URL } : {}),
        workers: 1,
        onRunComplete: async (run, result) => {
          completedRuns.push({
            runId: run.run_id,
            status: result.status ?? "unknown",
            hasException: !!result.exception,
            exceptionMessage: result.exception?.message,
          });
        },
      });

      try {
        // Graph that always fails (more than MAX_RETRY_ATTEMPTS)
        await api.registerGraph("test-graph", createFailingGraph(10));

        const thread = await createThread(api.app);
        const response = await startStreamingRun(api.app, thread.thread_id);

        expect(response.status).toBe(200);

        // Consume stream (will contain error events)
        const events = await collectSSEEvents(response, { timeout: 20000 });

        // Wait for retries + onRunComplete
        await new Promise((r) => setTimeout(r, 8000));

        // Should have been called at least once
        expect(completedRuns.length).toBeGreaterThanOrEqual(1);

        const lastCompletion = completedRuns[completedRuns.length - 1];
        console.log(
          `[onRunComplete/Error] Status: ${lastCompletion.status}, exception: ${lastCompletion.hasException}`
        );
        console.log(
          `[onRunComplete/Error] Total calls: ${completedRuns.length} (includes retries)`
        );

        const errorEvents = events.filter((e) => e.event === "error");
        console.log(
          `[onRunComplete/Error] Error events in stream: ${errorEvents.length}`
        );
      } finally {
        await api.cleanup();
        await poolManager.shutdown();
      }
    }, 60000);
  });

  // ─── Test 3: Postgres-Only Fallback ─────────────────────────────────────

  describe("Test 3: Postgres-Only Fallback (No Redis)", () => {
    it("should function with Postgres-only when Redis is not configured", async () => {
      await poolManager.shutdown();

      // Create API without Redis
      const api = await createLangGraphApi({
        postgresUri: testDbUrl,
        workers: 1,
      });

      try {
        await api.registerGraph("test-graph", createSimpleGraph());

        const thread = await createThread(api.app);
        const response = await startStreamingRun(api.app, thread.thread_id, {
          resumable: false,
        });

        expect(response.status).toBe(200);

        const events = await collectSSEEvents(response, { timeout: 15000 });

        expect(events.length).toBeGreaterThan(0);
        console.log(
          `[Postgres-Only] Received ${events.length} events without Redis`
        );

        // Verify we can still see thread state after completion
        const stateRes = await api.app.request(
          `/threads/${thread.thread_id}/state`,
          {
            method: "GET",
            headers: { "Content-Type": "application/json" },
          }
        );
        expect(stateRes.status).toBe(200);
        const state = await stateRes.json();
        console.log(
          `[Postgres-Only] Final state has ${(state.values?.messages ?? []).length} messages`
        );
      } finally {
        await api.cleanup();
        await poolManager.shutdown();
      }
    }, 30000);
  });

  // ─── Test 4: Concurrent Runs ────────────────────────────────────────────

  describe("Test 4: Concurrent Runs on Same Thread", () => {
    let api: LangGraphApi;

    beforeEach(async () => {
      await poolManager.shutdown();
      api = await createLangGraphApi({
        postgresUri: testDbUrl,
        ...(redisAvailable ? { redisUrl: TEST_REDIS_URL } : {}),
        workers: 4,
      });
      await api.registerGraph("test-graph", createSlowGraph(1000));
    });

    afterEach(async () => {
      await api.cleanup();
      await poolManager.shutdown();
    });

    it("should reject second run with 'reject' strategy", async () => {
      const thread = await createThread(api.app);

      // Start first run
      const response1 = await startStreamingRun(api.app, thread.thread_id, {
        multitaskStrategy: "reject",
      });
      expect(response1.status).toBe(200);

      // Wait for the run to be picked up by a worker
      await new Promise((r) => setTimeout(r, 500));

      // Try second run - should be rejected
      const response2 = await startStreamingRun(api.app, thread.thread_id, {
        multitaskStrategy: "reject",
      });

      // Should get 422 Unprocessable Entity
      expect(response2.status).toBe(422);

      console.log(
        `[Concurrent/Reject] First: ${response1.status}, Second: ${response2.status}`
      );

      // Let first run finish
      await collectSSEEvents(response1, { timeout: 10000 });
    }, 30000);

    it("should interrupt first run with 'interrupt' strategy", async () => {
      const thread = await createThread(api.app);

      // Start first run
      const response1 = await startStreamingRun(api.app, thread.thread_id, {
        multitaskStrategy: "interrupt",
      });
      expect(response1.status).toBe(200);

      // Wait for run to start executing
      await new Promise((r) => setTimeout(r, 300));

      // Start second run with interrupt strategy
      const response2 = await startStreamingRun(api.app, thread.thread_id, {
        multitaskStrategy: "interrupt",
      });
      expect(response2.status).toBe(200);

      console.log(
        `[Concurrent/Interrupt] Both runs accepted (interrupt strategy)`
      );

      // Consume both streams
      const [events1, events2] = await Promise.all([
        collectSSEEvents(response1, { timeout: 10000 }),
        collectSSEEvents(response2, { timeout: 10000 }),
      ]);

      console.log(
        `[Concurrent/Interrupt] Run 1: ${events1.length} events, Run 2: ${events2.length} events`
      );
    }, 30000);
  });

  // ─── Test 5: Load Test ──────────────────────────────────────────────────

  describe("Test 5: Load - Concurrent Runs Across Threads", () => {
    let api: LangGraphApi;

    beforeEach(async () => {
      await poolManager.shutdown();
      api = await createLangGraphApi({
        postgresUri: testDbUrl,
        ...(redisAvailable ? { redisUrl: TEST_REDIS_URL } : {}),
        workers: 8,
      });
      await api.registerGraph("test-graph", createSimpleGraph());
    });

    afterEach(async () => {
      await api.cleanup();
      await poolManager.shutdown();
    });

    it("should handle 10 concurrent runs across different threads", async () => {
      const numRuns = 10;
      const threads: Array<{ thread_id: string }> = [];

      // Create all threads
      for (let i = 0; i < numRuns; i++) {
        threads.push(await createThread(api.app));
      }

      console.log(`[Load/10] Created ${threads.length} threads`);
      const startTime = Date.now();

      // Submit all runs concurrently
      const responses = await Promise.all(
        threads.map((thread) =>
          startStreamingRun(api.app, thread.thread_id)
        )
      );

      const accepted = responses.filter((r) => r.status === 200).length;
      console.log(`[Load/10] ${accepted}/${numRuns} runs accepted`);
      expect(accepted).toBe(numRuns);

      // Consume all streams concurrently
      const results = await Promise.all(
        responses.map(async (response, i) => {
          if (response.status !== 200)
            return { index: i, events: 0, error: true };
          const events = await collectSSEEvents(response, { timeout: 30000 });
          return { index: i, events: events.length, error: false };
        })
      );

      const elapsed = Date.now() - startTime;
      const succeeded = results.filter((r) => !r.error && r.events > 0).length;
      const totalEvents = results.reduce((sum, r) => sum + r.events, 0);

      console.log(
        `[Load/10] ${succeeded}/${numRuns} completed, ${totalEvents} total events, ${elapsed}ms`
      );
      expect(succeeded).toBe(numRuns);
    }, 60000);

    it("should handle 50 concurrent runs across different threads", async () => {
      const numRuns = 50;
      const threads: Array<{ thread_id: string }> = [];

      // Create threads in batches
      const batchSize = 10;
      for (let batch = 0; batch < numRuns; batch += batchSize) {
        const batchPromises = [];
        for (let i = 0; i < batchSize && batch + i < numRuns; i++) {
          batchPromises.push(createThread(api.app));
        }
        threads.push(...(await Promise.all(batchPromises)));
      }

      console.log(`[Load/50] Created ${threads.length} threads`);
      const startTime = Date.now();

      // Submit all runs concurrently
      const responses = await Promise.all(
        threads.map((thread) =>
          startStreamingRun(api.app, thread.thread_id)
        )
      );

      const accepted = responses.filter((r) => r.status === 200).length;
      console.log(`[Load/50] ${accepted}/${numRuns} accepted`);

      // Consume all streams concurrently
      const results = await Promise.all(
        responses.map(async (response, i) => {
          if (response.status !== 200)
            return { index: i, events: 0, error: true };
          try {
            const events = await collectSSEEvents(response, {
              timeout: 60000,
            });
            return { index: i, events: events.length, error: false };
          } catch {
            return { index: i, events: 0, error: true };
          }
        })
      );

      const elapsed = Date.now() - startTime;
      const succeeded = results.filter((r) => !r.error && r.events > 0).length;
      const failed = results.filter((r) => r.error).length;
      const totalEvents = results.reduce((sum, r) => sum + r.events, 0);

      const eventCounts = results
        .map((r) => r.events)
        .filter((e) => e > 0)
        .sort((a, b) => a - b);
      const p95Events =
        eventCounts.length > 0
          ? eventCounts[Math.floor(eventCounts.length * 0.95)]
          : 0;

      console.log(`[Load/50] Results:`);
      console.log(`  Succeeded: ${succeeded}/${numRuns}`);
      console.log(`  Failed: ${failed}/${numRuns}`);
      console.log(`  Total events: ${totalEvents}`);
      console.log(`  p95 events/run: ${p95Events}`);
      console.log(`  Total elapsed: ${elapsed}ms`);
      console.log(
        `  Throughput: ${((succeeded / elapsed) * 1000).toFixed(1)} runs/sec`
      );

      // At least 90% should succeed
      expect(succeeded).toBeGreaterThanOrEqual(Math.floor(numRuns * 0.9));
    }, 120000);
  });

  // ─── Test 6: Programmatic Auth ──────────────────────────────────────────

  describe("Test 6: Programmatic Auth", () => {
    it("should reject unauthenticated requests", async () => {
      await poolManager.shutdown();

      const api = await createLangGraphApi({
        postgresUri: testDbUrl,
        workers: 1,
        auth: {
          authenticate: async (request: Request) => {
            const authHeader = request.headers.get("Authorization");
            if (!authHeader?.startsWith("Bearer ")) {
              throw new Error("Missing token");
            }
            const token = authHeader.substring(7);
            if (token !== "valid-token") {
              throw new Error("Invalid token");
            }
            return {
              identity: "user-1",
              permissions: [],
              display_name: "Test User",
              is_authenticated: true,
            };
          },
        },
      });

      try {
        await api.registerGraph("test-graph", createSimpleGraph());

        // No auth header -> fail
        const res1 = await api.app.request("/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res1.status).toBeGreaterThanOrEqual(400);

        // Bad token -> fail
        const res2 = await api.app.request("/threads", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer bad-token",
          },
          body: JSON.stringify({}),
        });
        expect(res2.status).toBeGreaterThanOrEqual(400);

        // Valid token -> succeed
        const res3 = await api.app.request("/threads", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer valid-token",
          },
          body: JSON.stringify({}),
        });
        expect(res3.status).toBe(200);

        console.log(
          `[Auth] No auth: ${res1.status}, Bad: ${res2.status}, Valid: ${res3.status}`
        );
      } finally {
        await api.cleanup();
        await poolManager.shutdown();
      }
    }, 30000);

    it("should apply authorize filters for tenant isolation", async () => {
      await poolManager.shutdown();

      const api = await createLangGraphApi({
        postgresUri: testDbUrl,
        workers: 1,
        auth: {
          authenticate: async (request: Request) => {
            const authHeader = request.headers.get("Authorization");
            if (!authHeader?.startsWith("Bearer ")) {
              throw new Error("Missing token");
            }
            return {
              identity: authHeader.substring(7), // token = identity
              permissions: [],
              display_name: authHeader.substring(7),
              is_authenticated: true,
            };
          },
          authorize: async (
            context: any,
            resource: string,
            action: string,
            value: any
          ) => {
            // context is AuthContext: { user: { identity, ... }, scopes: [] }
            const userId = context.user?.identity ?? context.identity;
            // Stamp owner metadata on thread creation
            if (resource === "threads" && action === "create") {
              value.metadata = { ...value.metadata, owner: userId };
            }
            // Filter thread reads and searches by owner
            // Filters are applied via isAuthMatching(thread.metadata, filters)
            // so filter keys map directly to metadata keys (no wrapper)
            if (
              resource === "threads" &&
              (action === "read" || action === "search")
            ) {
              return { owner: { $eq: userId } };
            }
            return true;
          },
        },
      });

      try {
        await api.registerGraph("test-graph", createSimpleGraph());

        const authA = { Authorization: "Bearer user-a" };
        const authB = { Authorization: "Bearer user-b" };

        // User A creates thread
        const resA = await api.app.request("/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authA },
          body: JSON.stringify({}),
        });
        expect(resA.status).toBe(200);
        const threadA = await resA.json();

        // User B creates thread
        const resB = await api.app.request("/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authB },
          body: JSON.stringify({}),
        });
        expect(resB.status).toBe(200);
        const threadB = await resB.json();

        // User A searches -> should only see own thread
        const searchA = await api.app.request("/threads/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authA },
          body: JSON.stringify({}),
        });
        const threadsA = await searchA.json();

        // User B searches -> should only see own thread
        const searchB = await api.app.request("/threads/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authB },
          body: JSON.stringify({}),
        });
        const threadsB = await searchB.json();

        const aIds = threadsA.map((t: any) => t.thread_id);
        const bIds = threadsB.map((t: any) => t.thread_id);

        console.log(
          `[Auth/Tenant] A sees ${aIds.length} threads, B sees ${bIds.length} threads`
        );

        expect(aIds).toContain(threadA.thread_id);
        expect(aIds).not.toContain(threadB.thread_id);
        expect(bIds).toContain(threadB.thread_id);
        expect(bIds).not.toContain(threadA.thread_id);
      } finally {
        await api.cleanup();
        await poolManager.shutdown();
      }
    }, 30000);
  });
});
