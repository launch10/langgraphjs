import { describe, it, expect } from "vitest";
import {
  stableHash,
  createStableId,
  createPrefixedStableId,
} from "../hash.js";

describe("stableHash", () => {
  it("produces same hash for same string", () => {
    expect(stableHash("hello")).toBe(stableHash("hello"));
  });

  it("produces different hash for different strings", () => {
    expect(stableHash("hello")).not.toBe(stableHash("world"));
  });

  it("produces same hash for same object regardless of key order", () => {
    const hash1 = stableHash({ a: 1, b: 2 });
    const hash2 = stableHash({ b: 2, a: 1 });
    expect(hash1).toBe(hash2);
  });

  it("produces same hash for same array", () => {
    expect(stableHash([1, 2, 3])).toBe(stableHash([1, 2, 3]));
  });

  it("produces different hash for different arrays", () => {
    expect(stableHash([1, 2, 3])).not.toBe(stableHash([3, 2, 1]));
  });

  it("handles nested objects", () => {
    const hash1 = stableHash({ a: { b: { c: 1 } } });
    const hash2 = stableHash({ a: { b: { c: 1 } } });
    expect(hash1).toBe(hash2);
  });

  it("handles null and undefined", () => {
    expect(stableHash(null)).toBe(stableHash(null));
    expect(stableHash(undefined)).toBe(stableHash(undefined));
    expect(stableHash(null)).not.toBe(stableHash(undefined));
  });

  it("returns 8-character hex string", () => {
    const hash = stableHash("test");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("createStableId", () => {
  it("creates ID from all fields when none specified", () => {
    const getId = createStableId<{ a: number; b: string }>();
    const id1 = getId({ a: 1, b: "x" });
    const id2 = getId({ a: 1, b: "x" });
    expect(id1).toBe(id2);
  });

  it("creates ID from specified fields only", () => {
    const getId = createStableId<{ text: string; status: string }>("text");
    const id1 = getId({ text: "hello", status: "pending" });
    const id2 = getId({ text: "hello", status: "approved" });
    expect(id1).toBe(id2);
  });

  it("different field values produce different IDs", () => {
    const getId = createStableId<{ text: string }>("text");
    const id1 = getId({ text: "hello" });
    const id2 = getId({ text: "world" });
    expect(id1).not.toBe(id2);
  });
});

describe("createPrefixedStableId", () => {
  it("adds prefix to generated ID", () => {
    const getId = createPrefixedStableId<{ text: string }>("h", "text");
    const id = getId({ text: "hello" });
    expect(id).toMatch(/^h-[0-9a-f]{8}$/);
  });

  it("same content produces same prefixed ID", () => {
    const getId = createPrefixedStableId<{ text: string }>("h", "text");
    const id1 = getId({ text: "hello" });
    const id2 = getId({ text: "hello" });
    expect(id1).toBe(id2);
  });

  it("different content produces different prefixed ID", () => {
    const getId = createPrefixedStableId<{ text: string }>("h", "text");
    const id1 = getId({ text: "hello" });
    const id2 = getId({ text: "world" });
    expect(id1).not.toBe(id2);
  });

  it("produces consistent IDs during streaming simulation", () => {
    const getId = createPrefixedStableId<{ text: string }>("h", "text");
    
    const streamUpdate1 = [{ text: "First headline" }];
    const streamUpdate2 = [{ text: "First headline" }, { text: "Second headline" }];
    
    const ids1 = streamUpdate1.map(getId);
    const ids2 = streamUpdate2.map(getId);
    
    expect(ids1[0]).toBe(ids2[0]);
  });
});
