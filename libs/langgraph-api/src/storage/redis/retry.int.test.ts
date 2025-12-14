import { describe, expect, it, vi } from "vitest";
import { withRetry, isRetryableRedisError } from "./retry.mjs";

describe("Redis withRetry", () => {
  describe("isRetryableRedisError", () => {
    it("should identify connection refused as retryable", () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:6379");
      (error as any).code = "ECONNREFUSED";
      expect(isRetryableRedisError(error)).toBe(true);
    });

    it("should identify connection reset as retryable", () => {
      const error = new Error("connection reset");
      (error as any).code = "ECONNRESET";
      expect(isRetryableRedisError(error)).toBe(true);
    });

    it("should identify socket closed as retryable", () => {
      const error = new Error("Socket closed unexpectedly");
      expect(isRetryableRedisError(error)).toBe(true);
    });

    it("should identify client is closed as retryable", () => {
      const error = new Error("The client is closed");
      expect(isRetryableRedisError(error)).toBe(true);
    });

    it("should identify connection timeout as retryable", () => {
      const error = new Error("Connection timeout");
      expect(isRetryableRedisError(error)).toBe(true);
    });

    it("should identify READONLY as retryable (failover)", () => {
      const error = new Error(
        "READONLY You can't write against a read only replica"
      );
      expect(isRetryableRedisError(error)).toBe(true);
    });

    it("should identify LOADING as retryable", () => {
      const error = new Error("LOADING Redis is loading the dataset in memory");
      expect(isRetryableRedisError(error)).toBe(true);
    });

    it("should identify CLUSTERDOWN as retryable", () => {
      const error = new Error("CLUSTERDOWN The cluster is down");
      expect(isRetryableRedisError(error)).toBe(true);
    });

    it("should NOT identify wrong type error as retryable", () => {
      const error = new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value"
      );
      expect(isRetryableRedisError(error)).toBe(false);
    });

    it("should NOT identify syntax error as retryable", () => {
      const error = new Error("ERR wrong number of arguments");
      expect(isRetryableRedisError(error)).toBe(false);
    });

    it("should NOT identify generic error as retryable", () => {
      const error = new Error("something went wrong");
      expect(isRetryableRedisError(error)).toBe(false);
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
      const error = new Error("Socket closed unexpectedly");

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
      const error = new Error("Socket closed unexpectedly");

      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(fn, {
          maxAttempts: 3,
          initialDelayMs: 10,
        })
      ).rejects.toThrow("Socket closed unexpectedly");

      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should NOT retry on non-retryable error", async () => {
      const error = new Error("WRONGTYPE Operation against a key");

      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(fn, {
          maxAttempts: 3,
          initialDelayMs: 10,
        })
      ).rejects.toThrow("WRONGTYPE");

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should use exponential backoff", async () => {
      const error = new Error("The client is closed");

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
  });
});
