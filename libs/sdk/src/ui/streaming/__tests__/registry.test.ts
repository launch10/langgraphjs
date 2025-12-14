import { describe, it, expect, vi, beforeEach } from "vitest";
import { SharedChatRegistry } from "../registry.js";
import { MergeStrategies } from "../merge.js";
import type { MessageWithBlocks, TextBlock } from "../types.js";

interface TestState {
  items: Array<{ id: string; value: number }>;
  count: number;
}

describe("SharedChatRegistry", () => {
  beforeEach(() => {
    SharedChatRegistry.clearAll();
  });

  describe("singleton behavior", () => {
    it("returns same registry for same key", () => {
      const registry1 = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      const registry2 = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      expect(registry1).toBe(registry2);
    });

    it("returns different registry for different key", () => {
      const registry1 = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      const registry2 = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-2",
      });

      expect(registry1).not.toBe(registry2);
    });

    it("creates new registry after cleanup", () => {
      const registry1 = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      SharedChatRegistry.acquire(registry1);
      registry1.updateState("count", 42);

      SharedChatRegistry.release(registry1);

      const registry2 = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      expect(registry2.getState().count).toBeUndefined();
    });

    it("handles default thread ID", () => {
      const registry1 = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      const registry2 = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        threadId: undefined,
      });

      expect(registry1).toBe(registry2);
    });
  });

  describe("reference counting", () => {
    it("increments on acquire", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      expect(SharedChatRegistry.getRefCount(registry)).toBe(0);

      SharedChatRegistry.acquire(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(1);

      SharedChatRegistry.acquire(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(2);
    });

    it("decrements on release", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      SharedChatRegistry.acquire(registry);
      SharedChatRegistry.acquire(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(2);

      SharedChatRegistry.release(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(1);
    });

    it("cleans up at zero", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        threadId: "cleanup-test",
      });

      SharedChatRegistry.acquire(registry);
      SharedChatRegistry.release(registry);

      const newRegistry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        threadId: "cleanup-test",
      });

      expect(newRegistry).not.toBe(registry);
    });

    it("does not go negative", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      SharedChatRegistry.release(registry);
      SharedChatRegistry.release(registry);

      const newRegistry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });
      expect(SharedChatRegistry.getRefCount(newRegistry)).toBe(0);
    });
  });

  describe("state management", () => {
    it("stores state correctly", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateState("count", 42);
      expect(registry.getState().count).toBe(42);
    });

    it("returns state copy (not reference)", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateState("count", 42);
      const state1 = registry.getState();
      const state2 = registry.getState();

      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });

    it("updates state via updateState", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateState("count", 1);
      expect(registry.getState().count).toBe(1);

      registry.updateState("count", 2);
      expect(registry.getState().count).toBe(2);
    });
  });

  describe("merge reducers", () => {
    it("applies reducer when present", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        merge: {
          items: MergeStrategies.appendUnique("id"),
        },
      });

      registry.loadFromHistory([], {
        items: [{ id: "a", value: 1 }],
      });
      registry.resetForStream();

      registry.updateState("items", [{ id: "b", value: 2 }]);

      const state = registry.getState();
      expect(state.items).toHaveLength(2);
      expect(state.items).toContainEqual({ id: "a", value: 1 });
      expect(state.items).toContainEqual({ id: "b", value: 2 });
    });

    it("uses replace when no reducer", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateState("count", 1);
      registry.updateState("count", 2);

      expect(registry.getState().count).toBe(2);
    });

    it("uses pre-stream state as base", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        merge: {
          items: MergeStrategies.append(),
        },
      });

      registry.loadFromHistory([], {
        items: [{ id: "a", value: 1 }],
      });
      registry.resetForStream();

      registry.updateState("items", [{ id: "b", value: 2 }]);
      registry.updateState("items", [{ id: "c", value: 3 }]);

      const state = registry.getState();
      expect(state.items).toEqual([
        { id: "a", value: 1 },
        { id: "c", value: 3 },
      ]);
    });
  });

  describe("pre-stream snapshot", () => {
    it("captures state on resetForStream", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        merge: {
          count: (incoming, current) => (current ?? 0) + incoming,
        },
      });

      registry.updateState("count", 10);
      registry.resetForStream();
      registry.updateState("count", 5);

      expect(registry.getState().count).toBe(15);
    });

    it("clears tools on reset", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateTools([{ id: "t1", name: "search", state: "complete" }]);
      expect(registry.getTools()).toHaveLength(1);

      registry.resetForStream();
      expect(registry.getTools()).toHaveLength(0);
    });
  });

  describe("subgraph state", () => {
    it("stores namespaced state separately", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateState("count", 42, ["parent", "child"]);

      expect(registry.getState().count).toBeUndefined();
      expect(registry.getSubgraphState(["parent", "child"])).toEqual({
        count: 42,
      });
    });

    it("returns correct subgraph state", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateState("count", 1, ["ns1"]);
      registry.updateState("count", 2, ["ns2"]);

      expect(registry.getSubgraphState(["ns1"])).toEqual({ count: 1 });
      expect(registry.getSubgraphState(["ns2"])).toEqual({ count: 2 });
    });

    it("clears on resetForStream", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateState("count", 42, ["ns"]);
      registry.resetForStream();

      expect(registry.getSubgraphState(["ns"])).toBeUndefined();
    });
  });

  describe("message management", () => {
    it("adds user messages", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.addUserMessage("Hello");

      const messages = registry.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect((messages[0].blocks[0] as TextBlock).text).toBe("Hello");
    });

    it("updates assistant messages", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateMessages([
        { type: "text", id: "b1", index: 0, text: "Hello" },
      ]);

      registry.updateMessages([
        { type: "text", id: "b1", index: 0, text: "Hello world" },
      ]);

      const messages = registry.getMessages();
      expect(messages).toHaveLength(1);
      expect((messages[0].blocks[0] as TextBlock).text).toBe("Hello world");
    });

    it("creates new assistant message when needed", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.addUserMessage("Question");
      registry.updateMessages([
        { type: "text", id: "b1", index: 0, text: "Answer" },
      ]);

      const messages = registry.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });

    it("maintains block order by index", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateMessages([
        { type: "text", id: "b2", index: 1, text: "Second" },
        { type: "text", id: "b1", index: 0, text: "First" },
      ]);

      const messages = registry.getMessages();
      expect(messages[0].blocks[0].index).toBe(0);
      expect(messages[0].blocks[1].index).toBe(1);
    });

    it("returns messages copy (not reference)", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.addUserMessage("Test");

      const messages1 = registry.getMessages();
      const messages2 = registry.getMessages();

      expect(messages1).not.toBe(messages2);
    });
  });

  describe("tool management", () => {
    it("updates tool state", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateTools([{ id: "t1", name: "search", state: "pending" }]);

      const tools = registry.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].state).toBe("pending");
    });

    it("merges by tool ID", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateTools([{ id: "t1", name: "search", state: "pending" }]);
      registry.updateTools([{ id: "t1", name: "search", state: "complete" }]);

      const tools = registry.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].state).toBe("complete");
    });

    it("returns tools copy (not reference)", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      registry.updateTools([{ id: "t1", name: "search", state: "pending" }]);

      const tools1 = registry.getTools();
      const tools2 = registry.getTools();

      expect(tools1).not.toBe(tools2);
    });
  });

  describe("subscriptions", () => {
    it("notifies on state change", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      const callback = vi.fn();
      registry.subscribeState(callback);

      registry.updateState("count", 42);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("notifies on message change", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      const callback = vi.fn();
      registry.subscribeMessages(callback);

      registry.addUserMessage("Hello");

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("notifies on tool change", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      const callback = vi.fn();
      registry.subscribeTools(callback);

      registry.updateTools([{ id: "t1", name: "search", state: "pending" }]);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe works", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      const callback = vi.fn();
      const unsubscribe = registry.subscribeState(callback);

      registry.updateState("count", 1);
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      registry.updateState("count", 2);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("no notification after unsubscribe", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      const callback = vi.fn();
      const unsubscribe = registry.subscribeMessages(callback);

      unsubscribe();

      registry.addUserMessage("Hello");
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("history loading", () => {
    it("loads messages and state", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      const messages: MessageWithBlocks[] = [
        {
          id: "m1",
          role: "user",
          blocks: [{ type: "text", id: "b1", index: 0, text: "Hello" }],
        },
      ];

      registry.loadFromHistory(messages, { count: 42 });

      expect(registry.getMessages()).toEqual(messages);
      expect(registry.getState().count).toBe(42);
    });

    it("updates pre-stream state", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
        merge: {
          count: (incoming, current) => (current ?? 0) + incoming,
        },
      });

      registry.loadFromHistory([], { count: 10 });
      registry.resetForStream();
      registry.updateState("count", 5);

      expect(registry.getState().count).toBe(15);
    });

    it("notifies subscribers", () => {
      const registry = SharedChatRegistry.getOrCreate<TestState>({
        apiUrl: "http://localhost:2024",
      });

      const stateCallback = vi.fn();
      const messageCallback = vi.fn();

      registry.subscribeState(stateCallback);
      registry.subscribeMessages(messageCallback);

      registry.loadFromHistory(
        [{ id: "m1", role: "user", blocks: [] }],
        { count: 1 }
      );

      expect(stateCallback).toHaveBeenCalled();
      expect(messageCallback).toHaveBeenCalled();
    });
  });

  describe("getKey", () => {
    it("generates correct key with all params", () => {
      expect(SharedChatRegistry.getKey("http://api.com", "assistant1", "thread1")).toBe(
        "http://api.com::assistant1::thread1"
      );
    });

    it("uses default for undefined assistantId", () => {
      expect(SharedChatRegistry.getKey("http://api.com", undefined, "thread1")).toBe(
        "http://api.com::default::thread1"
      );
    });

    it("uses __new__ for undefined threadId", () => {
      expect(SharedChatRegistry.getKey("http://api.com", "assistant1", undefined)).toBe(
        "http://api.com::assistant1::__new__"
      );
    });

    it("uses defaults for both undefined", () => {
      expect(SharedChatRegistry.getKey("http://api.com", undefined, undefined)).toBe(
        "http://api.com::default::__new__"
      );
    });
  });
});
