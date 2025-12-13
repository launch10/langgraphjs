import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import pg from "pg";
import { v4 as uuid4 } from "uuid";
import { PostgresOps, poolManager } from "../src/storage/postgres/index.mjs";

const { Pool } = pg;

const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";

let testDbName: string;
let testDbUrl: string;
let ops: PostgresOps;

beforeAll(async () => {
  const pool = new Pool({ connectionString: TEST_POSTGRES_URL });

  testDbName = `lg_api_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  try {
    await pool.query(`CREATE DATABASE ${testDbName}`);
    console.log(`Created test database: ${testDbName}`);

    testDbUrl = `${TEST_POSTGRES_URL.split("/").slice(0, -1).join("/")}/${testDbName}`;
    poolManager.configure({ uri: testDbUrl });
    ops = new PostgresOps({ uri: testDbUrl });
    await ops.setup();
  } finally {
    await pool.end();
  }
}, 30_000);

afterAll(async () => {
  await ops.shutdown();

  const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
  try {
    await pool.query(`DROP DATABASE ${testDbName} WITH (FORCE)`);
    console.log(`Dropped test database: ${testDbName}`);
  } finally {
    await pool.end();
  }
}, 30_000);

describe("PostgresOps - Assistants", () => {
  beforeEach(async () => {
    await ops.truncate({ assistants: true });
  });

  it("should create, read, update, and delete assistants", async () => {
    const assistantId = uuid4();
    const graphId = "test_graph";
    const config = { configurable: { model_name: "gpt" } };

    const created = await ops.assistants.put(
      assistantId,
      {
        graph_id: graphId,
        config,
        context: {},
        if_exists: "raise",
        name: "Test Assistant",
        description: "A test assistant",
      },
      undefined
    );

    expect(created.assistant_id).toBe(assistantId);
    expect(created.graph_id).toBe(graphId);
    expect(created.name).toBe("Test Assistant");
    expect(created.description).toBe("A test assistant");
    expect(created.config).toMatchObject(config);
    expect(created.version).toBe(1);

    const fetched = await ops.assistants.get(assistantId, undefined);
    expect(fetched.assistant_id).toBe(assistantId);

    const patched = await ops.assistants.patch(
      assistantId,
      {
        metadata: { updated: true },
        description: "Updated description",
      },
      undefined
    );
    expect(patched.metadata).toMatchObject({ updated: true });
    expect(patched.description).toBe("Updated description");
    expect(patched.version).toBe(2);

    const deleted = await ops.assistants.delete(assistantId, undefined);
    expect(deleted).toContain(assistantId);

    await expect(ops.assistants.get(assistantId, undefined)).rejects.toThrow();
  });

  it("should search assistants", async () => {
    const assistant1 = await ops.assistants.put(
      uuid4(),
      {
        graph_id: "graph_a",
        config: {},
        context: {},
        if_exists: "raise",
        name: "Assistant Alpha",
      },
      undefined
    );

    const assistant2 = await ops.assistants.put(
      uuid4(),
      {
        graph_id: "graph_b",
        config: {},
        context: {},
        if_exists: "raise",
        name: "Assistant Beta",
        metadata: { tier: "premium" },
      },
      undefined
    );

    const results: any[] = [];
    for await (const item of ops.assistants.search(
      { limit: 10, offset: 0 },
      undefined
    )) {
      results.push(item.assistant);
    }
    expect(results.length).toBe(2);

    const graphAResults: any[] = [];
    for await (const item of ops.assistants.search(
      { graph_id: "graph_a", limit: 10, offset: 0 },
      undefined
    )) {
      graphAResults.push(item.assistant);
    }
    expect(graphAResults.length).toBe(1);
    expect(graphAResults[0].assistant_id).toBe(assistant1.assistant_id);

    const nameResults: any[] = [];
    for await (const item of ops.assistants.search(
      { name: "Alpha", limit: 10, offset: 0 },
      undefined
    )) {
      nameResults.push(item.assistant);
    }
    expect(nameResults.length).toBe(1);
    expect(nameResults[0].name).toBe("Assistant Alpha");

    const metadataResults: any[] = [];
    for await (const item of ops.assistants.search(
      { metadata: { tier: "premium" }, limit: 10, offset: 0 },
      undefined
    )) {
      metadataResults.push(item.assistant);
    }
    expect(metadataResults.length).toBe(1);
    expect(metadataResults[0].assistant_id).toBe(assistant2.assistant_id);
  });

  it("should handle assistant versions", async () => {
    const assistantId = uuid4();

    await ops.assistants.put(
      assistantId,
      {
        graph_id: "test_graph",
        config: { configurable: { v: 1 } },
        context: {},
        if_exists: "raise",
      },
      undefined
    );

    await ops.assistants.patch(
      assistantId,
      { config: { configurable: { v: 2 } } },
      undefined
    );

    await ops.assistants.patch(
      assistantId,
      { config: { configurable: { v: 3 } } },
      undefined
    );

    const versions = await ops.assistants.getVersions(
      assistantId,
      { limit: 10, offset: 0 },
      undefined
    );
    expect(versions.length).toBe(3);
    expect(versions[0].version).toBe(3);
    expect(versions[1].version).toBe(2);
    expect(versions[2].version).toBe(1);

    const assistant = await ops.assistants.setLatest(
      assistantId,
      1,
      undefined
    );
    expect(assistant.version).toBe(1);
  });

  it("should count assistants", async () => {
    const initialCount = await ops.assistants.count({}, undefined);

    await ops.assistants.put(
      uuid4(),
      {
        graph_id: "graph_x",
        config: {},
        context: {},
        if_exists: "raise",
      },
      undefined
    );

    await ops.assistants.put(
      uuid4(),
      {
        graph_id: "graph_x",
        config: {},
        context: {},
        if_exists: "raise",
      },
      undefined
    );

    await ops.assistants.put(
      uuid4(),
      {
        graph_id: "graph_y",
        config: {},
        context: {},
        if_exists: "raise",
      },
      undefined
    );

    const totalCount = await ops.assistants.count({}, undefined);
    expect(totalCount).toBe(initialCount + 3);

    const graphXCount = await ops.assistants.count(
      { graph_id: "graph_x" },
      undefined
    );
    expect(graphXCount).toBe(2);
  });
});

describe("PostgresOps - Threads", () => {
  beforeEach(async () => {
    await ops.truncate({ threads: true, runs: true, checkpointer: true });
  });

  it("should create, read, update, and delete threads", async () => {
    const threadId = uuid4();
    const metadata = { name: "test_thread" };

    const created = await ops.threads.put(
      threadId,
      { metadata, if_exists: "raise" },
      undefined
    );

    expect(created.thread_id).toBe(threadId);
    expect(created.metadata).toMatchObject(metadata);
    expect(created.status).toBe("idle");

    const fetched = await ops.threads.get(threadId, undefined);
    expect(fetched.thread_id).toBe(threadId);

    const patched = await ops.threads.patch(
      threadId,
      { metadata: { modified: true } },
      undefined
    );
    expect(patched.metadata).toMatchObject({ name: "test_thread", modified: true });

    const deleted = await ops.threads.delete(threadId, undefined);
    expect(deleted).toContain(threadId);

    await expect(ops.threads.get(threadId, undefined)).rejects.toThrow();
  });

  it("should search threads", async () => {
    const thread1 = await ops.threads.put(
      uuid4(),
      { metadata: { type: "chat" }, if_exists: "raise" },
      undefined
    );

    const thread2 = await ops.threads.put(
      uuid4(),
      { metadata: { type: "task" }, if_exists: "raise" },
      undefined
    );

    const results: any[] = [];
    for await (const item of ops.threads.search(
      { limit: 10, offset: 0 },
      undefined
    )) {
      results.push(item.thread);
    }
    expect(results.length).toBe(2);

    const chatResults: any[] = [];
    for await (const item of ops.threads.search(
      { metadata: { type: "chat" }, limit: 10, offset: 0 },
      undefined
    )) {
      chatResults.push(item.thread);
    }
    expect(chatResults.length).toBe(1);
    expect(chatResults[0].thread_id).toBe(thread1.thread_id);

    const idResults: any[] = [];
    for await (const item of ops.threads.search(
      { ids: [thread2.thread_id], limit: 10, offset: 0 },
      undefined
    )) {
      idResults.push(item.thread);
    }
    expect(idResults.length).toBe(1);
    expect(idResults[0].thread_id).toBe(thread2.thread_id);
  });

  it("should count threads", async () => {
    await ops.threads.put(
      uuid4(),
      { metadata: { status: "active" }, if_exists: "raise" },
      undefined
    );

    await ops.threads.put(
      uuid4(),
      { metadata: { status: "active" }, if_exists: "raise" },
      undefined
    );

    await ops.threads.put(
      uuid4(),
      { metadata: { status: "inactive" }, if_exists: "raise" },
      undefined
    );

    const totalCount = await ops.threads.count({}, undefined);
    expect(totalCount).toBe(3);

    const activeCount = await ops.threads.count(
      { metadata: { status: "active" } },
      undefined
    );
    expect(activeCount).toBe(2);
  });

  it("should copy threads", async () => {
    const threadId = uuid4();

    await ops.threads.put(
      threadId,
      { metadata: { original: true }, if_exists: "raise" },
      undefined
    );

    const copied = await ops.threads.copy(threadId, undefined);

    expect(copied.thread_id).not.toBe(threadId);
    expect(copied.metadata).toMatchObject({ original: true, thread_id: copied.thread_id });
    expect(copied.status).toBe("idle");

    const original = await ops.threads.get(threadId, undefined);
    expect(original.thread_id).toBe(threadId);
  });
});

describe("PostgresOps - Runs", () => {
  let assistantId: string;

  beforeAll(async () => {
    assistantId = uuid4();
    await ops.assistants.put(
      assistantId,
      {
        graph_id: "test_graph",
        config: {},
        context: {},
        if_exists: "do_nothing",
      },
      undefined
    );
  });

  beforeEach(async () => {
    await ops.truncate({ runs: true, threads: true });
  });

  it("should create and retrieve runs", async () => {
    const threadId = uuid4();
    const runId = uuid4();

    const runs = await ops.runs.put(
      runId,
      assistantId,
      { input: { message: "hello" } },
      { threadId, ifNotExists: "create" },
      undefined
    );

    expect(runs.length).toBe(1);
    expect(runs[0].run_id).toBe(runId);
    expect(runs[0].thread_id).toBe(threadId);
    expect(runs[0].status).toBe("pending");

    const fetched = await ops.runs.get(runId, threadId, undefined);
    expect(fetched).not.toBeNull();
    expect(fetched!.run_id).toBe(runId);
  });

  it("should search runs", async () => {
    const threadId = uuid4();
    const runId1 = uuid4();
    const runId2 = uuid4();

    await ops.runs.put(
      runId1,
      assistantId,
      { input: { message: "run1" } },
      { threadId, ifNotExists: "create", metadata: { batch: "a" } },
      undefined
    );

    await ops.runs.put(
      runId2,
      assistantId,
      { input: { message: "run2" } },
      { threadId, metadata: { batch: "b" } },
      undefined
    );

    const allRuns = await ops.runs.search(
      threadId,
      { limit: 10, offset: 0 },
      undefined
    );
    expect(allRuns.length).toBe(2);

    const pendingRuns = await ops.runs.search(
      threadId,
      { status: "pending", limit: 10, offset: 0 },
      undefined
    );
    expect(pendingRuns.length).toBe(2);

    const batchARuns = await ops.runs.search(
      threadId,
      { metadata: { batch: "a" }, limit: 10, offset: 0 },
      undefined
    );
    expect(batchARuns.length).toBe(1);
    expect(batchARuns[0].run_id).toBe(runId1);
  });

  it("should delete runs", async () => {
    const threadId = uuid4();
    const runId = uuid4();

    await ops.runs.put(
      runId,
      assistantId,
      { input: {} },
      { threadId, ifNotExists: "create" },
      undefined
    );

    const deleted = await ops.runs.delete(runId, threadId, undefined);
    expect(deleted).toBe(runId);

    const fetched = await ops.runs.get(runId, threadId, undefined);
    expect(fetched).toBeNull();
  });

  it("should set run status", async () => {
    const threadId = uuid4();
    const runId = uuid4();

    await ops.runs.put(
      runId,
      assistantId,
      { input: {} },
      { threadId, ifNotExists: "create" },
      undefined
    );

    await ops.runs.setStatus(runId, "success");

    const run = await ops.runs.get(runId, threadId, undefined);
    expect(run!.status).toBe("success");
  });

  it("should handle multitask strategies", async () => {
    const threadId = uuid4();
    const runId1 = uuid4();
    const runId2 = uuid4();

    await ops.runs.put(
      runId1,
      assistantId,
      { input: {} },
      { threadId, ifNotExists: "create", multitaskStrategy: "reject" },
      undefined
    );

    const runsWithPrevention = await ops.runs.put(
      runId2,
      assistantId,
      { input: {} },
      { threadId, preventInsertInInflight: true },
      undefined
    );

    expect(runsWithPrevention.length).toBe(1);
    expect(runsWithPrevention[0].run_id).toBe(runId1);
  });
});

describe("PostgresOps - Stream Manager", () => {
  let assistantId: string;

  beforeAll(async () => {
    assistantId = uuid4();
    await ops.assistants.put(
      assistantId,
      {
        graph_id: "test_graph",
        config: {},
        context: {},
        if_exists: "do_nothing",
      },
      undefined
    );
  });

  beforeEach(async () => {
    await ops.truncate({ runs: true, threads: true });
  });

  it("should publish and receive stream events", async () => {
    const threadId = uuid4();
    const runId = uuid4();

    await ops.runs.put(
      runId,
      assistantId,
      { input: {} },
      { threadId, ifNotExists: "create" },
      undefined
    );

    await ops.runs.stream.publish({
      runId,
      event: "values",
      data: { test: "data" },
      resumable: false,
    });

    await ops.runs.stream.publish({
      runId,
      event: "metadata",
      data: { run_id: runId },
      resumable: false,
    });
  });
});

describe("PostgresOps - Truncate", () => {
  it("should truncate specific tables", async () => {
    const assistantId = uuid4();
    const threadId = uuid4();
    const runId = uuid4();

    await ops.assistants.put(
      assistantId,
      {
        graph_id: "test",
        config: {},
        context: {},
        if_exists: "do_nothing",
      },
      undefined
    );

    await ops.threads.put(
      threadId,
      { if_exists: "do_nothing" },
      undefined
    );

    await ops.runs.put(
      runId,
      assistantId,
      { input: {} },
      { threadId },
      undefined
    );

    await ops.truncate({ threads: true });

    const threadResults: any[] = [];
    for await (const item of ops.threads.search(
      { limit: 10, offset: 0 },
      undefined
    )) {
      threadResults.push(item.thread);
    }
    expect(threadResults.length).toBe(0);

    const assistantCount = await ops.assistants.count({}, undefined);
    expect(assistantCount).toBeGreaterThanOrEqual(1);
  });
});

describe("PostgresOps - Setup and Configuration", () => {
  it("should have correct table structure after setup", async () => {
    const pool = await ops.getPool();
    const schema = ops.getConfig().schema ?? "public";

    const tablesResult = await pool.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = $1 
       AND table_name IN ('assistants', 'assistant_versions', 'threads', 'runs')`,
      [schema]
    );

    expect(tablesResult.rows.length).toBe(4);
    const tableNames = tablesResult.rows.map((r) => r.table_name);
    expect(tableNames).toContain("assistants");
    expect(tableNames).toContain("assistant_versions");
    expect(tableNames).toContain("threads");
    expect(tableNames).toContain("runs");
  });

  it("should create indexes", async () => {
    const pool = await ops.getPool();
    const schema = ops.getConfig().schema ?? "public";

    const indexResult = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [schema]
    );

    const indexNames = indexResult.rows.map((r) => r.indexname);
    expect(indexNames).toContain("idx_runs_thread_id");
    expect(indexNames).toContain("idx_runs_status");
    expect(indexNames).toContain("idx_threads_status");
  });
});
