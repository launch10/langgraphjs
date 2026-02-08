import { describe, it, expect, beforeEach } from "vitest";
import { SharedChatRegistry } from "../../ui/streaming/registry.js";

describe("Convenience Hooks Dependencies", () => {
  beforeEach(() => {
    SharedChatRegistry.clearAll();
  });

  describe("useStreamUIState dependencies", () => {
    it("registry returns specific state key", () => {
      const registry = SharedChatRegistry.getOrCreate<{
        headlines: string[];
        count: number;
      }>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateState("headlines", ["A", "B"]);
      registry.updateState("count", 42);

      const state = registry.getState();
      expect(state.headlines).toEqual(["A", "B"]);
      expect(state.count).toBe(42);
    });

    it("returns undefined for missing key", () => {
      const registry = SharedChatRegistry.getOrCreate<{
        headlines: string[];
        count: number;
      }>({
        apiUrl: "http://localhost:2024",
      });

      const state = registry.getState();
      expect(state.headlines).toBeUndefined();
    });
  });

  describe("useStreamUIMessages dependencies", () => {
    it("registry returns messages array", () => {
      const registry = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
      });

      registry.addUserMessage("Hello");
      registry.updateMessages([
        { type: "text", id: "b1", index: 0, text: "Response" },
      ]);

      const messages = registry.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });

    it("returns empty array initially", () => {
      const registry = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
      });

      expect(registry.getMessages()).toEqual([]);
    });
  });

  describe("useStreamUITools dependencies", () => {
    it("registry returns tools array", () => {
      const registry = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateTools([
        { id: "t1", name: "search", state: "pending" },
        { id: "t2", name: "calculate", state: "running" },
      ]);

      const tools = registry.getTools();
      expect(tools).toHaveLength(2);
    });

    it("returns empty array initially", () => {
      const registry = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
      });

      expect(registry.getTools()).toEqual([]);
    });
  });

  describe("useSubgraphState dependencies", () => {
    it("registry returns namespaced state", () => {
      const registry = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateState("count" as never, 42 as never, ["parent", "child"]);

      const subState = registry.getSubgraphState(["parent", "child"]);
      expect(subState).toEqual({ count: 42 });
    });

    it("returns undefined for unknown namespace", () => {
      const registry = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
      });

      const subState = registry.getSubgraphState(["nonexistent"]);
      expect(subState).toBeUndefined();
    });
  });

  describe("registry sharing", () => {
    it("all hooks share same registry for same URL/threadId", () => {
      const registry1 = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      const registry2 = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      const registry3 = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      expect(registry1).toBe(registry2);
      expect(registry2).toBe(registry3);
    });

    it("different URL/threadId gets different registry", () => {
      const registry1 = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      const registry2 = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-2",
      });

      expect(registry1).not.toBe(registry2);
    });
  });

  describe("lifecycle management", () => {
    it("registry released on release call", () => {
      const registry = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
        threadId: "cleanup-test",
      });

      SharedChatRegistry.acquire(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(1);

      SharedChatRegistry.release(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(0);
    });

    it("handles multiple acquire/release cycles", () => {
      const registry = SharedChatRegistry.getOrCreate<Record<string, unknown>>({
        apiUrl: "http://localhost:2024",
      });

      SharedChatRegistry.acquire(registry);
      SharedChatRegistry.acquire(registry);
      SharedChatRegistry.acquire(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(3);

      SharedChatRegistry.release(registry);
      SharedChatRegistry.release(registry);
      SharedChatRegistry.release(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(0);
    });
  });

  describe("subscriptions", () => {
    it("state subscription fires on state update only", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
      });

      let stateCallCount = 0;
      let messageCallCount = 0;
      let toolCallCount = 0;

      registry.subscribeState(() => stateCallCount++);
      registry.subscribeMessages(() => messageCallCount++);
      registry.subscribeTools(() => toolCallCount++);

      registry.updateState("count", 42);

      expect(stateCallCount).toBe(1);
      expect(messageCallCount).toBe(0);
      expect(toolCallCount).toBe(0);
    });

    it("message subscription fires on message update only", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
      });

      let stateCallCount = 0;
      let messageCallCount = 0;
      let toolCallCount = 0;

      registry.subscribeState(() => stateCallCount++);
      registry.subscribeMessages(() => messageCallCount++);
      registry.subscribeTools(() => toolCallCount++);

      registry.addUserMessage("Hello");

      expect(stateCallCount).toBe(0);
      expect(messageCallCount).toBe(1);
      expect(toolCallCount).toBe(0);
    });

    it("tool subscription fires on tool update only", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
      });

      let stateCallCount = 0;
      let messageCallCount = 0;
      let toolCallCount = 0;

      registry.subscribeState(() => stateCallCount++);
      registry.subscribeMessages(() => messageCallCount++);
      registry.subscribeTools(() => toolCallCount++);

      registry.updateTools([{ id: "t1", name: "test", state: "pending" }]);

      expect(stateCallCount).toBe(0);
      expect(messageCallCount).toBe(0);
      expect(toolCallCount).toBe(1);
    });
  });
});
