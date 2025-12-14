import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";
import type { RedisClientType } from "redis";
import { createClient } from "redis";
import { v4 as uuid4 } from "uuid";
import {
  PostgresOps,
  poolManager,
  createPostgresOps,
} from "../src/storage/postgres/index.mjs";
import { RedisStreamManager } from "../src/storage/redis/stream.mjs";

const { Pool } = pg;

const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";

async function createRedisContainer(): Promise<{
  client: RedisClientType;
  url: string;
  cleanup: () => Promise<void>;
}> {
  const container = await new GenericContainer("redis:8")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .withStartupTimeout(120000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(6379);
  const url = `redis://${host}:${port}`;

  const client = createClient({ url }) as RedisClientType;

  let connected = false;
  let retries = 0;
  const maxRetries = 5;

  while (!connected && retries < maxRetries) {
    try {
      await client.connect();
      connected = true;
    } catch (error) {
      retries++;
      if (retries >= maxRetries) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 100 * Math.pow(2, retries - 1))
      );
    }
  }

  return {
    client,
    url,
    cleanup: async () => {
      try {
        if (client.isOpen) {
          await client.disconnect();
        }
      } catch {
        // ignore
      }

      try {
        await Promise.race([
          container.stop({ timeout: 10000 }),
          new Promise((resolve) => setTimeout(resolve, 10000)),
        ]);
      } catch (error) {
        console.error("Error stopping Redis container:", error);
      }
    },
  };
}

describe("Redis + Postgres API", () => {
  let redisClient: RedisClientType;
  let redisUrl: string;
  let cleanupRedis: () => Promise<void>;
  let testDbName: string;
  let testDbUrl: string;
  let streamManager: RedisStreamManager;
  let ops: PostgresOps;

  beforeAll(async () => {
    const redis = await createRedisContainer();
    redisClient = redis.client;
    redisUrl = redis.url;
    cleanupRedis = redis.cleanup;

    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    testDbName = `lg_redis_test_${Date.now()}_${Math.floor(
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
  }, 120000);

  afterAll(async () => {
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`DROP DATABASE ${testDbName} WITH (FORCE)`);
      console.log(`Dropped test database: ${testDbName}`);
    } finally {
      await pool.end();
    }
    await cleanupRedis();
  }, 30000);

  beforeEach(async () => {
    streamManager = new RedisStreamManager(redisUrl);
    await streamManager.connect();

    poolManager.configure({ uri: testDbUrl });
    ops = new PostgresOps({ uri: testDbUrl, streamManager });
    await ops.setup();

    await redisClient.flushAll();
  });

  afterEach(async () => {
    await ops.shutdown();
    await streamManager.close();
  });

  describe("PostgresOps with RedisStreamManager", () => {
    it("should use Redis for stream events", async () => {
      const runId = uuid4();
      const resumable = true;

      await ops.runs.stream.publish({
        runId,
        resumable,
        event: "values",
        data: { messages: ["hello"] },
      });

      const queue = ops.streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: true,
      });
      const [id, message] = await queue.get({ timeout: 1000 });

      expect(id).toBeDefined();
      expect(message.topic).toBe(`run:${runId}:stream:values`);
      expect(message.data).toEqual({ messages: ["hello"] });
    });

    it("should propagate events across instances sharing Redis", async () => {
      const streamManager2 = new RedisStreamManager(redisUrl);
      await streamManager2.connect();

      try {
        const ops2 = new PostgresOps({
          uri: testDbUrl,
          streamManager: streamManager2,
        });
        const runId = uuid4();

        await ops.runs.stream.publish({
          runId,
          resumable: true,
          event: "values",
          data: { from: "instance1" },
        });

        const queue2 = ops2.streamManager.getQueue(runId, {
          ifNotFound: "create",
          resumable: true,
        });
        const [, message] = await queue2.get({ timeout: 1000 });

        expect(message.topic).toBe(`run:${runId}:stream:values`);
        expect(message.data).toEqual({ from: "instance1" });
      } finally {
        await streamManager2.close();
      }
    });

    it("should support resumable streams with lastEventId", async () => {
      const runId = uuid4();

      await ops.runs.stream.publish({
        runId,
        resumable: true,
        event: "values",
        data: { step: 1 },
      });
      await ops.runs.stream.publish({
        runId,
        resumable: true,
        event: "values",
        data: { step: 2 },
      });
      await ops.runs.stream.publish({
        runId,
        resumable: true,
        event: "values",
        data: { step: 3 },
      });

      const queue = ops.streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: true,
      });

      const [id1, msg1] = await queue.get({ timeout: 1000 });
      expect(msg1.data).toEqual({ step: 1 });

      const queue2 = ops.streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: true,
      });
      const [, msg2] = await queue2.get({ timeout: 1000, lastEventId: id1 });
      expect(msg2.data).toEqual({ step: 2 });
    });
  });

  describe("Cross-instance cancellation", () => {
    it("should propagate cancel signal via Redis pub/sub", async () => {
      const streamManager2 = new RedisStreamManager(redisUrl);
      await streamManager2.connect();

      try {
        const ops2 = new PostgresOps({
          uri: testDbUrl,
          streamManager: streamManager2,
        });
        const runId = uuid4();

        const signal = await ops.streamManager.lockWithControl!(runId);
        expect(signal.aborted).toBe(false);

        await ops2.streamManager.publishControl!(runId, "interrupt");

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe("interrupt");
      } finally {
        await streamManager2.close();
      }
    });

    it("should support rollback action", async () => {
      const streamManager2 = new RedisStreamManager(redisUrl);
      await streamManager2.connect();

      try {
        const ops2 = new PostgresOps({
          uri: testDbUrl,
          streamManager: streamManager2,
        });
        const runId = uuid4();

        const signal = await ops.streamManager.lockWithControl!(runId);

        await ops2.streamManager.publishControl!(runId, "rollback");

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe("rollback");
      } finally {
        await streamManager2.close();
      }
    });
  });

  describe("createPostgresOps factory", () => {
    it("should auto-wire Redis when redisUrl provided", async () => {
      await poolManager.shutdown();

      const factoryOps = await createPostgresOps({
        postgresUri: testDbUrl,
        redisUrl,
      });

      expect(factoryOps.streamManager).toBeInstanceOf(RedisStreamManager);

      const runId = uuid4();
      await factoryOps.runs.stream.publish({
        runId,
        resumable: true,
        event: "test",
        data: { hello: "world" },
      });

      const queue = factoryOps.streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: true,
      });
      const [, msg] = await queue.get({ timeout: 1000 });
      expect(msg.data).toEqual({ hello: "world" });

      await factoryOps.shutdown();
      await (factoryOps.streamManager as RedisStreamManager).close();
    });

    it("should use in-memory stream manager when redisUrl not provided", async () => {
      await poolManager.shutdown();

      const factoryOps = await createPostgresOps({
        postgresUri: testDbUrl,
      });

      expect(factoryOps.streamManager).not.toBeInstanceOf(RedisStreamManager);

      await factoryOps.shutdown();
    });
  });

  describe("Run processing with Redis", () => {
    it("should lock/unlock runs using Redis", async () => {
      const runId = uuid4();

      expect(ops.streamManager.isLocked(runId)).toBe(false);

      const signal = ops.streamManager.lock(runId);
      expect(ops.streamManager.isLocked(runId)).toBe(true);
      expect(signal.aborted).toBe(false);

      ops.streamManager.unlock(runId);
      expect(ops.streamManager.isLocked(runId)).toBe(false);
    });

    it("should create assistants and threads with Redis-backed ops", async () => {
      const assistantId = uuid4();
      const threadId = uuid4();

      const assistant = await ops.assistants.put(
        assistantId,
        {
          graph_id: "test_graph",
          config: {},
          context: {},
          if_exists: "do_nothing",
          name: "Redis Test Assistant",
        },
        undefined
      );
      expect(assistant.assistant_id).toBe(assistantId);

      const thread = await ops.threads.put(
        threadId,
        { if_exists: "do_nothing", metadata: { test: true } },
        undefined
      );
      expect(thread.thread_id).toBe(threadId);
    });
  });
});
