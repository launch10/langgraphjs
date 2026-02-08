import { describe, it, expect, vi } from "vitest";
import { MergeStrategies } from "../merge.js";

interface Item {
  id: string;
  value: number;
}

describe("MergeStrategies", () => {
  describe("replace", () => {
    it("returns incoming value", () => {
      const reducer = MergeStrategies.replace<number>();
      expect(reducer(42, 10)).toBe(42);
    });

    it("ignores current value", () => {
      const reducer = MergeStrategies.replace<string>();
      expect(reducer("new", "old")).toBe("new");
    });

    it("handles undefined current", () => {
      const reducer = MergeStrategies.replace<number>();
      expect(reducer(42, undefined)).toBe(42);
    });

    it("works with objects", () => {
      const reducer = MergeStrategies.replace<{ a: number }>();
      const incoming = { a: 2 };
      expect(reducer(incoming, { a: 1 })).toBe(incoming);
    });
  });

  describe("append", () => {
    it("appends incoming to current", () => {
      const reducer = MergeStrategies.append<number>();
      expect(reducer([3, 4], [1, 2])).toEqual([1, 2, 3, 4]);
    });

    it("returns incoming when current undefined", () => {
      const reducer = MergeStrategies.append<number>();
      expect(reducer([1, 2], undefined)).toEqual([1, 2]);
    });

    it("handles empty current array", () => {
      const reducer = MergeStrategies.append<number>();
      expect(reducer([1, 2], [])).toEqual([1, 2]);
    });

    it("handles empty incoming array", () => {
      const reducer = MergeStrategies.append<number>();
      expect(reducer([], [1, 2])).toEqual([1, 2]);
    });

    it("handles both empty arrays", () => {
      const reducer = MergeStrategies.append<number>();
      expect(reducer([], [])).toEqual([]);
    });
  });

  describe("appendUnique", () => {
    it("deduplicates by key", () => {
      const reducer = MergeStrategies.appendUnique<Item, "id">("id");
      const current: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];
      const incoming: Item[] = [
        { id: "b", value: 20 },
        { id: "c", value: 3 },
      ];
      const result = reducer(incoming, current);

      expect(result).toHaveLength(3);
      expect(result.find((i) => i.id === "a")?.value).toBe(1);
      expect(result.find((i) => i.id === "b")?.value).toBe(20);
      expect(result.find((i) => i.id === "c")?.value).toBe(3);
    });

    it("newer items replace older", () => {
      const reducer = MergeStrategies.appendUnique<Item, "id">("id");
      const current: Item[] = [{ id: "a", value: 1 }];
      const incoming: Item[] = [{ id: "a", value: 100 }];

      const result = reducer(incoming, current);
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(100);
    });

    it("maintains insertion order", () => {
      const reducer = MergeStrategies.appendUnique<Item, "id">("id");
      const current: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];
      const incoming: Item[] = [{ id: "c", value: 3 }];

      const result = reducer(incoming, current);
      expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
    });

    it("handles undefined current", () => {
      const reducer = MergeStrategies.appendUnique<Item, "id">("id");
      const incoming: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];

      const result = reducer(incoming, undefined);
      expect(result).toEqual(incoming);
    });
  });

  describe("prepend", () => {
    it("prepends incoming to current", () => {
      const reducer = MergeStrategies.prepend<number>();
      expect(reducer([1, 2], [3, 4])).toEqual([1, 2, 3, 4]);
    });

    it("returns incoming when current undefined", () => {
      const reducer = MergeStrategies.prepend<number>();
      expect(reducer([1, 2], undefined)).toEqual([1, 2]);
    });

    it("handles empty current array", () => {
      const reducer = MergeStrategies.prepend<number>();
      expect(reducer([1, 2], [])).toEqual([1, 2]);
    });

    it("handles empty incoming array", () => {
      const reducer = MergeStrategies.prepend<number>();
      expect(reducer([], [1, 2])).toEqual([1, 2]);
    });

    it("handles both empty arrays", () => {
      const reducer = MergeStrategies.prepend<number>();
      expect(reducer([], [])).toEqual([]);
    });
  });

  describe("prependUnique", () => {
    it("deduplicates by key", () => {
      const reducer = MergeStrategies.prependUnique<Item, "id">("id");
      const current: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];
      const incoming: Item[] = [
        { id: "b", value: 20 },
        { id: "c", value: 3 },
      ];
      const result = reducer(incoming, current);

      expect(result).toHaveLength(3);
      expect(result.find((i) => i.id === "b")?.value).toBe(20);
    });

    it("new items appear first", () => {
      const reducer = MergeStrategies.prependUnique<Item, "id">("id");
      const current: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];
      const incoming: Item[] = [
        { id: "c", value: 3 },
        { id: "d", value: 4 },
      ];

      const result = reducer(incoming, current);
      expect(result.map((i) => i.id)).toEqual(["c", "d", "a", "b"]);
    });

    it("maintains order", () => {
      const reducer = MergeStrategies.prependUnique<Item, "id">("id");
      const current: Item[] = [{ id: "a", value: 1 }];
      const incoming: Item[] = [
        { id: "b", value: 2 },
        { id: "c", value: 3 },
      ];

      const result = reducer(incoming, current);
      expect(result.map((i) => i.id)).toEqual(["b", "c", "a"]);
    });

    it("handles undefined current", () => {
      const reducer = MergeStrategies.prependUnique<Item, "id">("id");
      const incoming: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];

      const result = reducer(incoming, undefined);
      expect(result).toEqual(incoming);
    });
  });

  describe("deepMerge", () => {
    it("merges top-level properties", () => {
      const reducer = MergeStrategies.deepMerge<{ a: number; b: number }>();
      const current = { a: 1, b: 2 };
      const incoming = { a: 10, b: 2 };

      const result = reducer(incoming, current);
      expect(result).toEqual({ a: 10, b: 2 });
    });

    it("recursively merges nested objects", () => {
      const reducer =
        MergeStrategies.deepMerge<{ outer: { inner: number; other: string } }>();
      const current = { outer: { inner: 1, other: "kept" } };
      const incoming = { outer: { inner: 2, other: "kept" } };

      const result = reducer(incoming, current);
      expect(result.outer.inner).toBe(2);
      expect(result.outer.other).toBe("kept");
    });

    it("replaces arrays (not merge)", () => {
      const reducer = MergeStrategies.deepMerge<{ arr: number[] }>();
      const current = { arr: [1, 2, 3] };
      const incoming = { arr: [4, 5] };

      const result = reducer(incoming, current);
      expect(result.arr).toEqual([4, 5]);
    });

    it("handles undefined current", () => {
      const reducer = MergeStrategies.deepMerge<{ a: number }>();
      const incoming = { a: 1 };

      const result = reducer(incoming, undefined);
      expect(result).toEqual(incoming);
    });

    it("handles null values in incoming", () => {
      const reducer =
        MergeStrategies.deepMerge<{ a: number | null; b: number }>();
      const current = { a: 1, b: 2 };
      const incoming = { a: null, b: 3 };

      const result = reducer(incoming, current);
      expect(result).toEqual({ a: null, b: 3 });
    });

    it("handles deeply nested objects", () => {
      const reducer =
        MergeStrategies.deepMerge<{ l1: { l2: { l3: { value: number } } } }>();
      const current = { l1: { l2: { l3: { value: 1 } } } };
      const incoming = { l1: { l2: { l3: { value: 2 } } } };

      const result = reducer(incoming, current);
      expect(result.l1.l2.l3.value).toBe(2);
    });

    it("adds new properties from incoming", () => {
      const reducer = MergeStrategies.deepMerge<{
        a: number;
        b?: number;
        c?: number;
      }>();
      const current = { a: 1, b: 2 };
      const incoming = { a: 1, c: 3 };

      const result = reducer(incoming, current);
      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });
  });

  describe("appendWithLimit", () => {
    it("appends and limits", () => {
      const reducer = MergeStrategies.appendWithLimit<number>(3);
      const result = reducer([3, 4], [1, 2]);

      expect(result).toEqual([2, 3, 4]);
    });

    it("removes oldest items first", () => {
      const reducer = MergeStrategies.appendWithLimit<number>(2);
      const result = reducer([4, 5], [1, 2, 3]);

      expect(result).toEqual([4, 5]);
    });

    it("handles limit larger than array", () => {
      const reducer = MergeStrategies.appendWithLimit<number>(100);
      const result = reducer([3, 4], [1, 2]);

      expect(result).toEqual([1, 2, 3, 4]);
    });

    it("handles undefined current", () => {
      const reducer = MergeStrategies.appendWithLimit<number>(2);
      const result = reducer([1, 2, 3, 4], undefined);

      expect(result).toEqual([3, 4]);
    });

    it("handles empty current", () => {
      const reducer = MergeStrategies.appendWithLimit<number>(3);
      const result = reducer([1, 2], []);

      expect(result).toEqual([1, 2]);
    });

    it("handles limit of 1", () => {
      const reducer = MergeStrategies.appendWithLimit<number>(1);
      const result = reducer([3], [1, 2]);

      expect(result).toEqual([3]);
    });
  });

  describe("upsert", () => {
    it("updates existing items by key", () => {
      const reducer = MergeStrategies.upsert<Item, "id">("id");
      const current: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];
      const incoming: Item[] = [{ id: "a", value: 100 }];

      const result = reducer(incoming, current);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "a", value: 100 });
      expect(result[1]).toEqual({ id: "b", value: 2 });
    });

    it("appends new items", () => {
      const reducer = MergeStrategies.upsert<Item, "id">("id");
      const current: Item[] = [{ id: "a", value: 1 }];
      const incoming: Item[] = [{ id: "b", value: 2 }];

      const result = reducer(incoming, current);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "a", value: 1 });
      expect(result[1]).toEqual({ id: "b", value: 2 });
    });

    it("maintains order for updates", () => {
      const reducer = MergeStrategies.upsert<Item, "id">("id");
      const current: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
        { id: "c", value: 3 },
      ];
      const incoming: Item[] = [{ id: "b", value: 200 }];

      const result = reducer(incoming, current);
      expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
      expect(result[1].value).toBe(200);
    });

    it("handles undefined current", () => {
      const reducer = MergeStrategies.upsert<Item, "id">("id");
      const incoming: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];

      const result = reducer(incoming, undefined);
      expect(result).toEqual(incoming);
    });

    it("handles mixed updates and inserts", () => {
      const reducer = MergeStrategies.upsert<Item, "id">("id");
      const current: Item[] = [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ];
      const incoming: Item[] = [
        { id: "b", value: 20 },
        { id: "c", value: 3 },
      ];

      const result = reducer(incoming, current);
      expect(result).toHaveLength(3);
      expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
      expect(result[1].value).toBe(20);
    });
  });

  describe("custom", () => {
    it("calls custom function", () => {
      const customFn = vi.fn(
        (incoming: number, current: number | undefined) => {
          return (current ?? 0) + incoming;
        }
      );
      const reducer = MergeStrategies.custom(customFn);

      const result = reducer(5, 10);
      expect(result).toBe(15);
      expect(customFn).toHaveBeenCalledWith(5, 10);
    });

    it("catches errors", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const customFn = (): number => {
        throw new Error("Test error");
      };
      const reducer = MergeStrategies.custom(customFn);

      const result = reducer(42, 10);
      expect(result).toBe(42);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("uses fallback on error", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const customFn = (): number => {
        throw new Error("Test error");
      };
      const fallback = (incoming: number) => incoming * 2;
      const reducer = MergeStrategies.custom(customFn, fallback);

      const result = reducer(42, 10);
      expect(result).toBe(84);

      consoleSpy.mockRestore();
    });

    it("returns incoming if no fallback and error", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const customFn = (): string => {
        throw new Error("Test error");
      };
      const reducer = MergeStrategies.custom(customFn);

      const result = reducer("incoming", "current");
      expect(result).toBe("incoming");

      consoleSpy.mockRestore();
    });

    it("handles undefined current", () => {
      const customFn = (incoming: number, current: number | undefined) => {
        return (current ?? 0) + incoming;
      };
      const reducer = MergeStrategies.custom(customFn);

      const result = reducer(5, undefined);
      expect(result).toBe(5);
    });
  });

  describe("type safety", () => {
    it("replace preserves type", () => {
      const reducer = MergeStrategies.replace<{ x: number }>();
      const result = reducer({ x: 1 }, { x: 2 });
      expect(result.x).toBe(1);
    });

    it("append preserves array element type", () => {
      const reducer = MergeStrategies.append<{ n: number }>();
      const result = reducer([{ n: 3 }], [{ n: 1 }, { n: 2 }]);
      expect(result[2].n).toBe(3);
    });

    it("appendUnique enforces key type", () => {
      const reducer = MergeStrategies.appendUnique<Item, "id">("id");
      const result = reducer([{ id: "b", value: 2 }], [{ id: "a", value: 1 }]);
      expect(result.every((item) => typeof item.id === "string")).toBe(true);
    });

    it("deepMerge preserves nested types", () => {
      interface Nested {
        outer: { inner: { value: number } };
      }
      const reducer = MergeStrategies.deepMerge<Nested>();
      const result = reducer(
        { outer: { inner: { value: 2 } } },
        { outer: { inner: { value: 1 } } }
      );
      expect(result.outer.inner.value).toBe(2);
    });
  });

  describe("immutability", () => {
    it("append returns new array", () => {
      const reducer = MergeStrategies.append<number>();
      const current = [1, 2];
      const incoming = [3, 4];
      const result = reducer(incoming, current);

      expect(result).not.toBe(current);
      expect(result).not.toBe(incoming);
    });

    it("prepend returns new array", () => {
      const reducer = MergeStrategies.prepend<number>();
      const current = [1, 2];
      const incoming = [3, 4];
      const result = reducer(incoming, current);

      expect(result).not.toBe(current);
      expect(result).not.toBe(incoming);
    });

    it("deepMerge returns new object", () => {
      const reducer = MergeStrategies.deepMerge<{ a: number }>();
      const current = { a: 1 };
      const incoming = { a: 2 };
      const result = reducer(incoming, current);

      expect(result).not.toBe(current);
      expect(result).not.toBe(incoming);
    });

    it("upsert returns new array", () => {
      const reducer = MergeStrategies.upsert<Item, "id">("id");
      const current: Item[] = [{ id: "a", value: 1 }];
      const incoming: Item[] = [{ id: "a", value: 2 }];
      const result = reducer(incoming, current);

      expect(result).not.toBe(current);
      expect(result).not.toBe(incoming);
    });
  });
});
