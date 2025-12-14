import { describe, it, expect, vi, beforeEach } from "vitest";
import { SharedChatRegistry } from "../../ui/streaming/registry.js";
import { UIEventProcessor } from "../../ui/streaming/processor.js";
import { isUIEvent } from "../../ui/streaming/types.js";
import type { UIStateStreamingEvent, UIStateFinalEvent } from "../../ui/streaming/types.js";

describe("useStreamUI dependencies", () => {
  beforeEach(() => {
    SharedChatRegistry.clearAll();
  });

  describe("SharedChatRegistry integration", () => {
    it("creates registry with correct options", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      expect(registry).toBeDefined();
      expect(registry.getKey()).toBe("http://localhost:2024::thread-1");
    });

    it("shares registry across components with same key", () => {
      const registry1 = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      const registry2 = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
        threadId: "thread-1",
      });

      expect(registry1).toBe(registry2);
    });

    it("acquires and releases correctly", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
      });

      SharedChatRegistry.acquire(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(1);

      SharedChatRegistry.acquire(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(2);

      SharedChatRegistry.release(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(1);

      SharedChatRegistry.release(registry);
      expect(SharedChatRegistry.getRefCount(registry)).toBe(0);
    });
  });

  describe("UIEventProcessor integration", () => {
    it("processes UI events correctly", () => {
      const processor = new UIEventProcessor<{ count: number }>();

      const event: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 42,
      };

      const result = processor.process(event);

      expect(result.stateUpdates).toEqual({ count: 42 });
    });

    it("handles finalization", () => {
      const processor = new UIEventProcessor<{ count: number }>();

      const event: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 100,
      };

      const result = processor.process(event);

      expect(result.stateUpdates).toEqual({ count: 100 });
      expect(result.isStateFinal).toBe(true);
      expect(processor.isKeyFinalized("count")).toBe(true);
    });

    it("resets state", () => {
      const processor = new UIEventProcessor<{ count: number }>();

      const event: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 100,
      };

      processor.process(event);
      expect(processor.isKeyFinalized("count")).toBe(true);

      processor.reset();
      expect(processor.isKeyFinalized("count")).toBe(false);
    });
  });

  describe("isUIEvent type guard", () => {
    it("returns true for valid UI events", () => {
      const event: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 42,
      };

      expect(isUIEvent(event)).toBe(true);
    });

    it("returns false for non-UI events", () => {
      const event = { type: "some:other:event", data: "foo" };
      expect(isUIEvent(event)).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(isUIEvent(null)).toBe(false);
      expect(isUIEvent(undefined)).toBe(false);
    });
  });

  describe("registry subscriptions", () => {
    it("notifies subscribers on state update", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
      });

      const callback = vi.fn();
      const unsubscribe = registry.subscribeState(callback);

      registry.updateState("count", 42);

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      registry.updateState("count", 100);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("notifies subscribers on message update", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
      });

      const callback = vi.fn();
      const unsubscribe = registry.subscribeMessages(callback);

      registry.addUserMessage("Hello");

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it("notifies subscribers on tool update", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
      });

      const callback = vi.fn();
      const unsubscribe = registry.subscribeTools(callback);

      registry.updateTools([{ id: "t1", name: "search", state: "pending" }]);

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
    });
  });

  describe("integration flow", () => {
    it("processes events and updates registry", () => {
      const registry = SharedChatRegistry.getOrCreate<{ headlines: string[] }>({
        apiUrl: "http://localhost:2024",
      });

      const processor = new UIEventProcessor<{ headlines: string[] }>();

      const event: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "headlines",
        value: ["Hello", "World"],
      };

      const result = processor.process(event);

      if (result.stateUpdates) {
        for (const [key, value] of Object.entries(result.stateUpdates)) {
          registry.updateState(
            key as keyof { headlines: string[] },
            value as string[]
          );
        }
      }

      expect(registry.getState().headlines).toEqual(["Hello", "World"]);
    });

    it("handles optimistic messages", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
      });

      registry.addUserMessage("What is the weather?");

      const messages = registry.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
    });

    it("resets for new stream", () => {
      const registry = SharedChatRegistry.getOrCreate<{ count: number }>({
        apiUrl: "http://localhost:2024",
      });

      const processor = new UIEventProcessor<{ count: number }>();

      registry.updateState("count", 42);
      registry.updateTools([{ id: "t1", name: "search", state: "complete" }]);

      const finalEvent: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 100,
      };
      processor.process(finalEvent);

      registry.resetForStream();
      processor.reset();

      expect(registry.getTools()).toHaveLength(0);
      expect(processor.isKeyFinalized("count")).toBe(false);
    });
  });
});
