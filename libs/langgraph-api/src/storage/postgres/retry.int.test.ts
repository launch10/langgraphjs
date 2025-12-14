import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { withRetry, isRetryableError } from "./retry.mjs";
import { poolManager } from "./pool.mjs";

const { Pool } = pg;

const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";

describe("withRetry", () => {
  describe("isRetryableError", () => {
    it("should identify connection refused as retryable", () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      (error as any).code = "ECONNREFUSED";
      expect(isRetryableError(error)).toBe(true);
    });

    it("should identify connection reset as retryable", () => {
      const error = new Error("connection reset");
      (error as any).code = "ECONNRESET";
      expect(isRetryableError(error)).toBe(true);
    });

    it("should identify connection timeout as retryable", () => {
      const error = new Error("timeout");
      (error as any).code = "ETIMEDOUT";
      expect(isRetryableError(error)).toBe(true);
    });

    it("should identify pool exhaustion as retryable", () => {
      const error = new Error("timeout exceeded when trying to connect");
      expect(isRetryableError(error)).toBe(true);
    });

    it("should identify Postgres connection terminated as retryable", () => {
      const error = new Error("Connection terminated unexpectedly");
      (error as any).code = "57P01";
      expect(isRetryableError(error)).toBe(true);
    });

    it("should identify Postgres admin shutdown as retryable", () => {
      const error = new Error("admin shutdown");
      (error as any).code = "57P02";
      expect(isRetryableError(error)).toBe(true);
    });

    it("should NOT identify constraint violation as retryable", () => {
      const error = new Error("duplicate key value violates unique constraint");
      (error as any).code = "23505";
      expect(isRetryableError(error)).toBe(false);
    });

    it("should NOT identify syntax error as retryable", () => {
      const error = new Error("syntax error at or near");
      (error as any).code = "42601";
      expect(isRetryableError(error)).toBe(false);
    });

    it("should NOT identify generic error as retryable", () => {
      const error = new Error("something went wrong");
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe("retry behavior", () => {
    it("should succeed on first try if no error", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await withRetry(fn);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on transient error and succeed", async () => {
      const error = new Error("connect ECONNREFUSED");
      (error as any).code = "ECONNREFUSED";

      const fn = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue("success after retry");

      const result = await withRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 10,
      });

      expect(result).toBe("success after retry");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should throw after max attempts exceeded", async () => {
      const error = new Error("connect ECONNREFUSED");
      (error as any).code = "ECONNREFUSED";

      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(fn, {
          maxAttempts: 3,
          initialDelayMs: 10,
        })
      ).rejects.toThrow("connect ECONNREFUSED");

      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should NOT retry on non-retryable error", async () => {
      const error = new Error("duplicate key value");
      (error as any).code = "23505";

      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(fn, {
          maxAttempts: 3,
          initialDelayMs: 10,
        })
      ).rejects.toThrow("duplicate key value");

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should use exponential backoff", async () => {
      const error = new Error("timeout");
      (error as any).code = "ETIMEDOUT";

      const fn = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue("success");

      const startTime = Date.now();
      await withRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 50,
        backoffFactor: 2,
        maxDelayMs: 500,
      });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should cap delay at maxDelayMs", async () => {
      const error = new Error("timeout");
      (error as any).code = "ETIMEDOUT";

      const fn = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue("success");

      const startTime = Date.now();
      await withRetry(fn, {
        maxAttempts: 10,
        initialDelayMs: 100,
        backoffFactor: 10,
        maxDelayMs: 150,
      });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(1000);
      expect(fn).toHaveBeenCalledTimes(5);
    });
  });

  describe("integration with Postgres", () => {
    let pool: pg.Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    });

    afterAll(async () => {
      await pool.end();
    });

    it("should wrap a successful query", async () => {
      const result = await withRetry(async () => {
        const res = await pool.query("SELECT 1 as value");
        return res.rows[0].value;
      });

      expect(result).toBe(1);
    });

    it("should wrap a query and handle real syntax error without retry", async () => {
      await expect(
        withRetry(async () => {
          await pool.query("SELEC 1");
        })
      ).rejects.toThrow();
    });
  });

  describe("poolManager.query with retry", () => {
    beforeAll(async () => {
      await poolManager.shutdown();
      poolManager.configure({ uri: TEST_POSTGRES_URL });
    });

    afterAll(async () => {
      await poolManager.shutdown();
    });

    it("should execute query with retry wrapper", async () => {
      const result = await poolManager.query<{ value: number }>(
        "SELECT 1 as value"
      );
      expect(result.rows[0].value).toBe(1);
    });

    it("should pass query parameters", async () => {
      const result = await poolManager.query<{ sum: number }>(
        "SELECT $1::int + $2::int as sum",
        [10, 20]
      );
      expect(result.rows[0].sum).toBe(30);
    });

    it("should not retry on syntax errors", async () => {
      await expect(poolManager.query("SELEC 1")).rejects.toThrow();
    });
  });
});
