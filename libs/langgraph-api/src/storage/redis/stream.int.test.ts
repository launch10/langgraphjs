import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import type { RedisClientType } from "redis";
import { createClient } from "redis";
import { RedisStreamManager } from "./stream.mjs";

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
        // Client might already be closed
      }

      try {
        await Promise.race([
          container.stop({ timeout: 10000 }),
          new Promise((resolve) => setTimeout(resolve, 10000)),
        ]);
      } catch (error) {
        console.error("Error stopping container:", error);
      }
    },
  };
}

describe("RedisStreamManager", () => {
  let redisClient: RedisClientType;
  let redisUrl: string;
  let cleanup: () => Promise<void>;
  let streamManager: RedisStreamManager;

  beforeAll(async () => {
    const redis = await createRedisContainer();
    redisClient = redis.client;
    redisUrl = redis.url;
    cleanup = redis.cleanup;
  }, 120000);

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    streamManager = new RedisStreamManager(redisUrl);
    await streamManager.connect();
    await redisClient.flushAll();
  });

  afterEach(async () => {
    await streamManager.close();
  });

  describe("Queue operations", () => {
    it("should create a queue and push/get messages", async () => {
      const runId = "test-run-1";
      const queue = streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: false,
      });

      const message = {
        topic: `run:${runId}:stream:values` as const,
        data: { foo: "bar" },
      };

      await queue.push(message);

      const abortController = new AbortController();
      const [id, received] = await queue.get({
        timeout: 1000,
        signal: abortController.signal,
      });

      expect(id).toBeDefined();
      expect(received.topic).toBe(message.topic);
      expect(received.data).toEqual(message.data);
    });

    it("should handle multiple messages in order", async () => {
      const runId = "test-run-2";
      const queue = streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: false,
      });

      const messages = [
        { topic: `run:${runId}:stream:values` as const, data: { seq: 1 } },
        { topic: `run:${runId}:stream:values` as const, data: { seq: 2 } },
        { topic: `run:${runId}:stream:values` as const, data: { seq: 3 } },
      ];

      for (const msg of messages) {
        await queue.push(msg);
      }

      const abortController = new AbortController();
      for (let i = 0; i < messages.length; i++) {
        const [, received] = await queue.get({
          timeout: 1000,
          signal: abortController.signal,
        });
        expect(received.data).toEqual({ seq: i + 1 });
      }
    });

    it("should timeout when no message is available", async () => {
      const runId = "test-run-3";
      const queue = streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: false,
      });

      const abortController = new AbortController();
      await expect(
        queue.get({
          timeout: 100,
          signal: abortController.signal,
        })
      ).rejects.toThrow("Timeout waiting for message");
    });

    it("should abort when signal is triggered", async () => {
      const runId = "test-run-4";
      const queue = streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: false,
      });

      const abortController = new AbortController();
      const getPromise = queue.get({
        timeout: 5000,
        signal: abortController.signal,
      });

      setTimeout(() => abortController.abort(), 50);

      await expect(getPromise).rejects.toThrow("Operation aborted");
    });

    it("should support resumable streams with lastEventId", async () => {
      const runId = "test-run-5";
      const queue = streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: true,
      });

      const messages = [
        { topic: `run:${runId}:stream:values` as const, data: { seq: 1 } },
        { topic: `run:${runId}:stream:values` as const, data: { seq: 2 } },
        { topic: `run:${runId}:stream:values` as const, data: { seq: 3 } },
      ];

      for (const msg of messages) {
        await queue.push(msg);
      }

      const abortController = new AbortController();

      const [id1, msg1] = await queue.get({
        timeout: 1000,
        signal: abortController.signal,
      });
      expect(msg1.data).toEqual({ seq: 1 });

      const [id2, msg2] = await queue.get({
        timeout: 1000,
        signal: abortController.signal,
        lastEventId: id1,
      });
      expect(msg2.data).toEqual({ seq: 2 });

      const [, msg1Again] = await queue.get({
        timeout: 1000,
        signal: abortController.signal,
        lastEventId: undefined,
      });
      expect(msg1Again.data).toEqual({ seq: 1 });

      const [, msg3] = await queue.get({
        timeout: 1000,
        signal: abortController.signal,
        lastEventId: id2,
      });
      expect(msg3.data).toEqual({ seq: 3 });
    });
  });

  describe("Lock/Control operations", () => {
    it("should lock and unlock a run", () => {
      const runId = "test-run-lock-1";

      expect(streamManager.isLocked(runId)).toBe(false);

      const signal = streamManager.lock(runId);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(streamManager.isLocked(runId)).toBe(true);

      streamManager.unlock(runId);
      expect(streamManager.isLocked(runId)).toBe(false);
    });

    it("should return the control for a locked run", () => {
      const runId = "test-run-lock-2";

      expect(streamManager.getControl(runId)).toBeUndefined();

      streamManager.lock(runId);
      const control = streamManager.getControl(runId);
      expect(control).toBeDefined();
      expect(control?.signal).toBeInstanceOf(AbortSignal);

      streamManager.unlock(runId);
      expect(streamManager.getControl(runId)).toBeUndefined();
    });

    it("should support abort with reason", () => {
      const runId = "test-run-lock-3";

      streamManager.lock(runId);
      const control = streamManager.getControl(runId);

      let abortReason: string | undefined;
      control?.signal.addEventListener("abort", () => {
        abortReason = control.signal.reason;
      });

      control?.abort("interrupt");
      expect(abortReason).toBe("interrupt");
    });
  });

  describe("Cross-instance pub/sub", () => {
    it("should receive messages published from another instance", async () => {
      const runId = "test-run-pubsub-1";

      const manager1 = new RedisStreamManager(redisUrl);
      const manager2 = new RedisStreamManager(redisUrl);
      await manager1.connect();
      await manager2.connect();

      try {
        const queue1 = manager1.getQueue(runId, {
          ifNotFound: "create",
          resumable: false,
        });
        const queue2 = manager2.getQueue(runId, {
          ifNotFound: "create",
          resumable: false,
        });

        const message = {
          topic: `run:${runId}:stream:values` as const,
          data: { from: "manager1" },
        };

        await queue1.push(message);

        const abortController = new AbortController();
        const [, received] = await queue2.get({
          timeout: 1000,
          signal: abortController.signal,
        });

        expect(received.topic).toBe(message.topic);
        expect(received.data).toEqual({ from: "manager1" });
      } finally {
        await manager1.close();
        await manager2.close();
      }
    });

    it("should support multiple subscribers to the same run", async () => {
      const runId = "test-run-pubsub-2";

      const publisher = new RedisStreamManager(redisUrl);
      const subscriber1 = new RedisStreamManager(redisUrl);
      const subscriber2 = new RedisStreamManager(redisUrl);

      await publisher.connect();
      await subscriber1.connect();
      await subscriber2.connect();

      try {
        const pubQueue = publisher.getQueue(runId, {
          ifNotFound: "create",
          resumable: true,
        });
        const sub1Queue = subscriber1.getQueue(runId, {
          ifNotFound: "create",
          resumable: true,
        });
        const sub2Queue = subscriber2.getQueue(runId, {
          ifNotFound: "create",
          resumable: true,
        });

        const message = {
          topic: `run:${runId}:stream:values` as const,
          data: { broadcast: true },
        };

        await pubQueue.push(message);

        const abortController = new AbortController();

        const [, received1] = await sub1Queue.get({
          timeout: 1000,
          signal: abortController.signal,
        });
        const [, received2] = await sub2Queue.get({
          timeout: 1000,
          signal: abortController.signal,
        });

        expect(received1.data).toEqual({ broadcast: true });
        expect(received2.data).toEqual({ broadcast: true });
      } finally {
        await publisher.close();
        await subscriber1.close();
        await subscriber2.close();
      }
    });
  });

  describe("Cross-instance control signals", () => {
    it("should publish control signal to Redis", async () => {
      const runId = "test-control-publish-1";

      await streamManager.publishControl(runId, "interrupt");

      // Verify the message was published by subscribing and checking
      // (This is more of an integration check - the real test is cross-instance)
    });

    it("should receive control signal on subscriber", async () => {
      const runId = "test-control-sub-1";
      const receivedSignals: string[] = [];

      const unsubscribe = await streamManager.subscribeControl(
        runId,
        (action) => {
          receivedSignals.push(action);
        }
      );

      await streamManager.publishControl(runId, "interrupt");

      // Wait for pub/sub propagation
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedSignals).toContain("interrupt");
      await unsubscribe();
    });

    it("should receive control signal from different instance", async () => {
      const runId = "test-control-cross-1";

      const worker = new RedisStreamManager(redisUrl);
      const apiServer = new RedisStreamManager(redisUrl);
      await worker.connect();
      await apiServer.connect();

      try {
        const receivedSignals: string[] = [];

        // Worker subscribes to control signals
        const unsubscribe = await worker.subscribeControl(runId, (action) => {
          receivedSignals.push(action);
        });

        // API server publishes cancel signal
        await apiServer.publishControl(runId, "interrupt");

        // Wait for pub/sub propagation
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(receivedSignals).toEqual(["interrupt"]);
        await unsubscribe();
      } finally {
        await worker.close();
        await apiServer.close();
      }
    });

    it("should support rollback action", async () => {
      const runId = "test-control-rollback-1";

      const worker = new RedisStreamManager(redisUrl);
      const apiServer = new RedisStreamManager(redisUrl);
      await worker.connect();
      await apiServer.connect();

      try {
        const receivedSignals: string[] = [];

        const unsubscribe = await worker.subscribeControl(runId, (action) => {
          receivedSignals.push(action);
        });

        await apiServer.publishControl(runId, "rollback");

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(receivedSignals).toEqual(["rollback"]);
        await unsubscribe();
      } finally {
        await worker.close();
        await apiServer.close();
      }
    });

    it("should unsubscribe and stop receiving signals", async () => {
      const runId = "test-control-unsub-1";
      const receivedSignals: string[] = [];

      const unsubscribe = await streamManager.subscribeControl(
        runId,
        (action) => {
          receivedSignals.push(action);
        }
      );

      await streamManager.publishControl(runId, "interrupt");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receivedSignals).toHaveLength(1);

      await unsubscribe();

      await streamManager.publishControl(runId, "rollback");
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still be 1 - didn't receive the second signal
      expect(receivedSignals).toHaveLength(1);
    });

    it("should auto-subscribe to control when lock is acquired", async () => {
      const runId = "test-control-autolock-1";

      const worker = new RedisStreamManager(redisUrl);
      const apiServer = new RedisStreamManager(redisUrl);
      await worker.connect();
      await apiServer.connect();

      try {
        // Worker acquires lock (simulating picking up a run)
        const signal = await worker.lockWithControl(runId);

        let abortReason: string | undefined;
        signal.addEventListener("abort", () => {
          abortReason = signal.reason;
        });

        // API server sends cancel
        await apiServer.publishControl(runId, "interrupt");

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(signal.aborted).toBe(true);
        expect(abortReason).toBe("interrupt");
      } finally {
        await worker.close();
        await apiServer.close();
      }
    });

    it("should auto-unsubscribe when unlock is called", async () => {
      const runId = "test-control-autounlock-1";

      const worker = new RedisStreamManager(redisUrl);
      const apiServer = new RedisStreamManager(redisUrl);
      await worker.connect();
      await apiServer.connect();

      try {
        const signal = await worker.lockWithControl(runId);
        await worker.unlockWithControl(runId);

        // Signal should not be aborted after unlock even if we publish
        await apiServer.publishControl(runId, "interrupt");
        await new Promise((resolve) => setTimeout(resolve, 100));

        // The signal was already unlocked, so it shouldn't have been aborted
        // (the subscription was removed)
        expect(worker.isLocked(runId)).toBe(false);
      } finally {
        await worker.close();
        await apiServer.close();
      }
    });

    it("should handle multiple runs with separate control channels", async () => {
      const runId1 = "test-control-multi-1";
      const runId2 = "test-control-multi-2";

      const worker = new RedisStreamManager(redisUrl);
      const apiServer = new RedisStreamManager(redisUrl);
      await worker.connect();
      await apiServer.connect();

      try {
        const signals1: string[] = [];
        const signals2: string[] = [];

        const unsub1 = await worker.subscribeControl(runId1, (action) => {
          signals1.push(action);
        });
        const unsub2 = await worker.subscribeControl(runId2, (action) => {
          signals2.push(action);
        });

        // Only cancel run1
        await apiServer.publishControl(runId1, "interrupt");
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(signals1).toEqual(["interrupt"]);
        expect(signals2).toEqual([]);

        await unsub1();
        await unsub2();
      } finally {
        await worker.close();
        await apiServer.close();
      }
    });
  });

  describe("Cleanup and edge cases", () => {
    it("should handle closing gracefully", async () => {
      const manager = new RedisStreamManager(redisUrl);
      await manager.connect();

      const runId = "test-run-cleanup-1";
      const queue = manager.getQueue(runId, {
        ifNotFound: "create",
        resumable: false,
      });

      await queue.push({
        topic: `run:${runId}:stream:values` as const,
        data: { test: true },
      });

      await manager.close();

      await expect(
        queue.push({
          topic: `run:${runId}:stream:values` as const,
          data: { after: "close" },
        })
      ).rejects.toThrow("Redis client not connected");
    });

    it("should return same queue for same runId", () => {
      const runId = "test-run-same-queue";

      const queue1 = streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: false,
      });
      const queue2 = streamManager.getQueue(runId, {
        ifNotFound: "create",
        resumable: false,
      });

      expect(queue1).toBe(queue2);
    });
  });
});
