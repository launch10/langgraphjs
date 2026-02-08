import { describe, it, expect } from "vitest";
import {
  runWithParsingContext,
  runWithParsingContextAsync,
  cacheStructuredData,
  getCachedStructuredData,
  getParsingStore,
} from "../src/utils/parsing-context.mjs";

describe("parsing-context", () => {
  describe("runWithParsingContext", () => {
    it("creates a store within the context", () => {
      let storeInside: unknown;
      runWithParsingContext(() => {
        storeInside = getParsingStore();
      });
      expect(storeInside).toBeInstanceOf(Map);
    });

    it("store is undefined outside context", () => {
      expect(getParsingStore()).toBeUndefined();
    });
  });

  describe("cacheStructuredData", () => {
    it("caches raw data without modification", () => {
      runWithParsingContext(() => {
        const input = {
          headlines: [{ text: "Headline 1" }, { text: "Headline 2" }],
        };
        const result = cacheStructuredData("msg-1", input);

        expect(result).toBe(input);
        expect(result.headlines).toHaveLength(2);
        expect(result.headlines[0]).not.toHaveProperty("id");
      });
    });

    it("returns data even outside context", () => {
      const input = { headlines: [{ text: "Test" }] };
      const result = cacheStructuredData("msg-1", input);
      expect(result).toBe(input);
    });
  });

  describe("getCachedStructuredData", () => {
    it("returns undefined when not in context", () => {
      expect(getCachedStructuredData("msg-1")).toBeUndefined();
    });

    it("returns undefined for uncached messageId", () => {
      runWithParsingContext(() => {
        expect(getCachedStructuredData("msg-1")).toBeUndefined();
      });
    });

    it("returns cached data after cacheStructuredData", () => {
      runWithParsingContext(() => {
        const input = { headlines: [{ text: "Test" }] };
        cacheStructuredData("msg-1", input);

        const cached = getCachedStructuredData("msg-1");
        expect(cached).toBeDefined();
        expect(cached?.data).toBe(input);
      });
    });

    it("overwrites cached data on subsequent calls", () => {
      runWithParsingContext(() => {
        cacheStructuredData("msg-1", { headlines: [{ text: "First" }] });
        cacheStructuredData("msg-1", { headlines: [{ text: "Second" }] });

        const cached = getCachedStructuredData("msg-1");
        expect(cached?.data.headlines[0].text).toBe("Second");
      });
    });
  });

  describe("async context", () => {
    it("maintains context across async operations", async () => {
      await runWithParsingContextAsync(async () => {
        cacheStructuredData("msg-1", { headlines: [{ text: "Before await" }] });

        await new Promise((resolve) => setTimeout(resolve, 10));

        const cached = getCachedStructuredData("msg-1");
        expect(cached).toBeDefined();
        expect(cached?.data.headlines[0].text).toBe("Before await");
      });
    });
  });
});
