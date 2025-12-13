import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { Pool } from "pg";
import * as pg from "pg";
import { PostgresNotifier } from "../src/storage/postgres/notifier.mjs";

const { Pool: PgPool } = (pg as any).default ?? pg;

const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";

describe("PostgresNotifier", () => {
  let pool: Pool;
  let notifier: PostgresNotifier;

  beforeAll(async () => {
    pool = new PgPool({ connectionString: TEST_POSTGRES_URL });
    await pool.query("SELECT 1");
  }, 30000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        assistant_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        metadata JSONB NOT NULL DEFAULT '{}',
        kwargs JSONB NOT NULL DEFAULT '{}',
        multitask_strategy TEXT NOT NULL DEFAULT 'reject',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    notifier = new PostgresNotifier(TEST_POSTGRES_URL!);
    await notifier.connect();
  });

  afterEach(async () => {
    await notifier.close();
    await pool.query("DROP TABLE IF EXISTS runs CASCADE");
    await pool.query("DROP FUNCTION IF EXISTS notify_new_run() CASCADE");
  });

  describe("Basic LISTEN/NOTIFY", () => {
    it("should connect and listen on a channel", async () => {
      const channel = "test_channel";
      const receivedPayloads: string[] = [];

      await notifier.listen(channel, (payload) => {
        receivedPayloads.push(payload);
      });

      await pool.query(`SELECT pg_notify($1, $2)`, [channel, "test_payload"]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receivedPayloads).toContain("test_payload");
    });

    it("should receive multiple notifications", async () => {
      const channel = "multi_test";
      const receivedPayloads: string[] = [];

      await notifier.listen(channel, (payload) => {
        receivedPayloads.push(payload);
      });

      await pool.query(`SELECT pg_notify($1, $2)`, [channel, "payload_1"]);
      await pool.query(`SELECT pg_notify($1, $2)`, [channel, "payload_2"]);
      await pool.query(`SELECT pg_notify($1, $2)`, [channel, "payload_3"]);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(receivedPayloads).toHaveLength(3);
      expect(receivedPayloads).toEqual(["payload_1", "payload_2", "payload_3"]);
    });

    it("should support multiple listeners on same channel", async () => {
      const channel = "shared_channel";
      const received1: string[] = [];
      const received2: string[] = [];

      await notifier.listen(channel, (payload) => received1.push(payload));
      await notifier.listen(channel, (payload) => received2.push(payload));

      await pool.query(`SELECT pg_notify($1, $2)`, [channel, "shared_payload"]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received1).toContain("shared_payload");
      expect(received2).toContain("shared_payload");
    });

    it("should support multiple channels", async () => {
      const received: Record<string, string[]> = { ch1: [], ch2: [] };

      await notifier.listen("ch1", (payload) => received.ch1.push(payload));
      await notifier.listen("ch2", (payload) => received.ch2.push(payload));

      await pool.query(`SELECT pg_notify('ch1', 'for_ch1')`);
      await pool.query(`SELECT pg_notify('ch2', 'for_ch2')`);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received.ch1).toEqual(["for_ch1"]);
      expect(received.ch2).toEqual(["for_ch2"]);
    });

    it("should unlisten from a channel", async () => {
      const channel = "unlisten_test";
      const received: string[] = [];

      const unsubscribe = await notifier.listen(channel, (payload) => {
        received.push(payload);
      });

      await pool.query(`SELECT pg_notify($1, $2)`, [channel, "before"]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 50));

      await pool.query(`SELECT pg_notify($1, $2)`, [channel, "after"]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(received).toEqual(["before"]);
    });
  });

  describe("Run notifications with triggers", () => {
    beforeEach(async () => {
      await notifier.setupRunTrigger(pool, "public");
    });

    it("should notify when a pending run is inserted", async () => {
      const receivedRunIds: string[] = [];

      await notifier.listen("new_run", (payload) => {
        receivedRunIds.push(payload);
      });

      await pool.query(
        `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
        ["run-001", "thread-001", "assistant-001"]
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receivedRunIds).toContain("run-001");
    });

    it("should not notify for non-pending runs", async () => {
      const receivedRunIds: string[] = [];

      await notifier.listen("new_run", (payload) => {
        receivedRunIds.push(payload);
      });

      await pool.query(
        `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'running')`,
        ["run-002", "thread-002", "assistant-002"]
      );
      await pool.query(
        `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'success')`,
        ["run-003", "thread-003", "assistant-003"]
      );
      await pool.query(
        `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'error')`,
        ["run-004", "thread-004", "assistant-004"]
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receivedRunIds).toHaveLength(0);
    });

    it("should handle multiple pending run inserts", async () => {
      const receivedRunIds: string[] = [];

      await notifier.listen("new_run", (payload) => {
        receivedRunIds.push(payload);
      });

      await pool.query(
        `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
        ["run-a", "thread-a", "assistant-a"]
      );
      await pool.query(
        `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
        ["run-b", "thread-b", "assistant-b"]
      );
      await pool.query(
        `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
        ["run-c", "thread-c", "assistant-c"]
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(receivedRunIds).toHaveLength(3);
      expect(receivedRunIds).toContain("run-a");
      expect(receivedRunIds).toContain("run-b");
      expect(receivedRunIds).toContain("run-c");
    });

    it("should not notify on status update", async () => {
      const receivedRunIds: string[] = [];

      await pool.query(
        `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
        ["run-update", "thread-update", "assistant-update"]
      );

      await notifier.listen("new_run", (payload) => {
        receivedRunIds.push(payload);
      });

      receivedRunIds.length = 0;

      await pool.query(`UPDATE runs SET status = 'running' WHERE run_id = $1`, [
        "run-update",
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receivedRunIds).toHaveLength(0);
    });
  });

  describe("waitForNotification", () => {
    it("should resolve when notification is received", async () => {
      const channel = "wait_test";

      const waitPromise = notifier.waitForNotification(channel, 5000);

      setTimeout(async () => {
        await pool.query(`SELECT pg_notify($1, $2)`, [
          channel,
          "awaited_payload",
        ]);
      }, 50);

      const payload = await waitPromise;
      expect(payload).toBe("awaited_payload");
    });

    it("should timeout if no notification received", async () => {
      const channel = "timeout_test";

      await expect(notifier.waitForNotification(channel, 100)).rejects.toThrow(
        "Timeout"
      );
    });

    it("should abort when signal is triggered", async () => {
      const channel = "abort_test";
      const controller = new AbortController();

      const waitPromise = notifier.waitForNotification(
        channel,
        5000,
        controller.signal
      );

      setTimeout(() => controller.abort(), 50);

      await expect(waitPromise).rejects.toThrow();
    });
  });

  describe("Connection resilience", () => {
    it("should handle connection close gracefully", async () => {
      const channel = "close_test";
      let errorReceived = false;

      notifier.on("error", () => {
        errorReceived = true;
      });

      await notifier.listen(channel, () => {});
      await notifier.close();

      expect(errorReceived).toBe(false);
    });

    it("should report when connected", async () => {
      expect(notifier.isConnected()).toBe(true);
      await notifier.close();
      expect(notifier.isConnected()).toBe(false);
    });

    it("should emit error event on connection failure during listen", async () => {
      const badNotifier = new PostgresNotifier(
        "postgresql://invalid:invalid@localhost:1/invalid"
      );

      await expect(badNotifier.connect()).rejects.toThrow();
    });
  });

  describe("Schema support", () => {
    const customSchema = "test_notifier_schema";

    beforeEach(async () => {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${customSchema}`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${customSchema}.runs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          assistant_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          metadata JSONB NOT NULL DEFAULT '{}',
          kwargs JSONB NOT NULL DEFAULT '{}',
          multitask_strategy TEXT NOT NULL DEFAULT 'reject',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    });

    afterEach(async () => {
      await pool.query(`DROP TABLE IF EXISTS ${customSchema}.runs CASCADE`);
      await pool.query(
        `DROP FUNCTION IF EXISTS ${customSchema}.notify_new_run() CASCADE`
      );
      await pool.query(`DROP SCHEMA IF EXISTS ${customSchema} CASCADE`);
    });

    it("should setup trigger in custom schema", async () => {
      await notifier.setupRunTrigger(pool, customSchema);
      const receivedRunIds: string[] = [];

      await notifier.listen(`${customSchema}_new_run`, (payload) => {
        receivedRunIds.push(payload);
      });

      await pool.query(
        `INSERT INTO ${customSchema}.runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
        ["run-schema-001", "thread-schema-001", "assistant-schema-001"]
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receivedRunIds).toContain("run-schema-001");
    });
  });

  describe("Edge cases", () => {
    it("should handle empty payload", async () => {
      const channel = "empty_payload";
      const received: string[] = [];

      await notifier.listen(channel, (payload) => {
        received.push(payload);
      });

      await pool.query(`SELECT pg_notify($1, $2)`, [channel, ""]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toEqual([""]);
    });

    it("should handle JSON payload", async () => {
      const channel = "json_payload";
      const received: string[] = [];

      await notifier.listen(channel, (payload) => {
        received.push(payload);
      });

      const jsonPayload = JSON.stringify({ run_id: "test", priority: "high" });
      await pool.query(`SELECT pg_notify($1, $2)`, [channel, jsonPayload]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0])).toEqual({
        run_id: "test",
        priority: "high",
      });
    });

    it("should handle rapid notifications", async () => {
      const channel = "rapid_test";
      const received: string[] = [];

      await notifier.listen(channel, (payload) => {
        received.push(payload);
      });

      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          pool.query(`SELECT pg_notify($1, $2)`, [channel, `msg_${i}`])
        );
      }
      await Promise.all(promises);

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(received.length).toBe(100);
    });

    it("should handle special characters in payload", async () => {
      const channel = "special_chars";
      const received: string[] = [];

      await notifier.listen(channel, (payload) => {
        received.push(payload);
      });

      const specialPayload =
        "Test with 'quotes' and \"double quotes\" and \\ backslash";
      await pool.query(`SELECT pg_notify($1, $2)`, [channel, specialPayload]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toContain(specialPayload);
    });

    it("should queue notifications received before listener setup completes", async () => {
      const channel = "race_condition";
      const received: string[] = [];

      await pool.query(`SELECT pg_notify($1, $2)`, [channel, "early_bird"]);

      await notifier.listen(channel, (payload) => {
        received.push(payload);
      });

      await pool.query(`SELECT pg_notify($1, $2)`, [channel, "after_listen"]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toContain("after_listen");
    });
  });
});

describe("Queue integration with PostgresNotifier", () => {
  let pool: Pool;
  let notifier: PostgresNotifier;

  beforeAll(async () => {
    pool = new PgPool({ connectionString: TEST_POSTGRES_URL });
    await pool.query("SELECT 1");
  }, 30000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        assistant_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        metadata JSONB NOT NULL DEFAULT '{}',
        kwargs JSONB NOT NULL DEFAULT '{}',
        multitask_strategy TEXT NOT NULL DEFAULT 'reject',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    notifier = new PostgresNotifier(TEST_POSTGRES_URL!);
    await notifier.connect();
    await notifier.setupRunTrigger(pool, "public");
  });

  afterEach(async () => {
    await notifier.close();
    await pool.query("DROP TABLE IF EXISTS runs CASCADE");
    await pool.query("DROP FUNCTION IF EXISTS notify_new_run() CASCADE");
  });

  it("should wake up immediately when run is inserted", async () => {
    const startTime = Date.now();
    let notificationTime: number | null = null;

    const waitPromise = notifier
      .waitForNotification("new_run", 5000)
      .then((payload) => {
        notificationTime = Date.now();
        return payload;
      });

    await new Promise((resolve) => setTimeout(resolve, 50));

    await pool.query(
      `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
      ["run-immediate", "thread-immediate", "assistant-immediate"]
    );

    const runId = await waitPromise;

    expect(runId).toBe("run-immediate");
    expect(notificationTime! - startTime).toBeLessThan(500);
  });

  it("should process runs in order of notification", async () => {
    const receivedOrder: string[] = [];

    await notifier.listen("new_run", (payload) => {
      receivedOrder.push(payload);
    });

    await pool.query(
      `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
      ["run-first", "thread-1", "assistant-1"]
    );
    await pool.query(
      `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
      ["run-second", "thread-2", "assistant-2"]
    );
    await pool.query(
      `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
      ["run-third", "thread-3", "assistant-3"]
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(receivedOrder).toEqual(["run-first", "run-second", "run-third"]);
  });

  it("should work with concurrent listeners (simulating multiple workers)", async () => {
    const notifier2 = new PostgresNotifier(TEST_POSTGRES_URL!);
    await notifier2.connect();

    const received1: string[] = [];
    const received2: string[] = [];

    await notifier.listen("new_run", (payload) => received1.push(payload));
    await notifier2.listen("new_run", (payload) => received2.push(payload));

    await pool.query(
      `INSERT INTO runs (run_id, thread_id, assistant_id, status) VALUES ($1, $2, $3, 'pending')`,
      ["run-concurrent", "thread-concurrent", "assistant-concurrent"]
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(received1).toContain("run-concurrent");
    expect(received2).toContain("run-concurrent");

    await notifier2.close();
  });

  it("should fall back to polling timeout when no notifications", async () => {
    const startTime = Date.now();
    const timeout = 200;

    await expect(
      notifier.waitForNotification("new_run", timeout)
    ).rejects.toThrow("Timeout");

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);
    expect(elapsed).toBeLessThan(timeout + 100);
  });
});
