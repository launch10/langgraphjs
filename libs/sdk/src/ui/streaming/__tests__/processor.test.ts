import { describe, it, expect, vi, beforeEach } from "vitest";
import { UIEventProcessor } from "../processor.js";
import type {
  UIStateStreamingEvent,
  UIStateFinalEvent,
  UIContentTextEvent,
  UIContentStructuredEvent,
  UIContentReasoningEvent,
  UIToolStartEvent,
  UIToolInputEvent,
  UIToolOutputEvent,
  UIToolErrorEvent,
} from "../types.js";

interface TestState {
  headlines: Array<{ id: string; text: string }>;
  count: number;
  settings: { theme: string };
}

describe("UIEventProcessor", () => {
  let processor: UIEventProcessor<TestState>;

  beforeEach(() => {
    processor = new UIEventProcessor<TestState>();
  });

  describe("state streaming events", () => {
    it("processes streaming events correctly", () => {
      const event: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "headlines",
        value: [{ id: "1", text: "Hello" }],
      };

      const result = processor.process(event);

      expect(result.stateUpdates).toEqual({
        headlines: [{ id: "1", text: "Hello" }],
      });
    });

    it("returns state updates", () => {
      const event: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 42,
      };

      const result = processor.process(event);

      expect(result.stateUpdates?.count).toBe(42);
    });
  });

  describe("state finalization", () => {
    it("processes final events correctly", () => {
      const event: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "headlines",
        value: [{ id: "1", text: "Final" }],
      };

      const result = processor.process(event);

      expect(result.stateUpdates).toEqual({
        headlines: [{ id: "1", text: "Final" }],
      });
    });

    it("marks key as finalized", () => {
      const event: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "headlines",
        value: [],
      };

      processor.process(event);

      expect(processor.isKeyFinalized("headlines")).toBe(true);
    });

    it("returns isStateFinal: true", () => {
      const event: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "headlines",
        value: [],
      };

      const result = processor.process(event);

      expect(result.isStateFinal).toBe(true);
    });
  });

  describe("ignoring after finalization", () => {
    it("ignores streaming events for finalized keys", () => {
      const finalEvent: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "headlines",
        value: [{ id: "1", text: "Final" }],
      };

      const streamingEvent: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        key: "headlines",
        value: [{ id: "2", text: "Should be ignored" }],
      };

      processor.process(finalEvent);
      const result = processor.process(streamingEvent);

      expect(result.stateUpdates).toEqual({});
    });

    it("still processes final events for other keys", () => {
      const finalHeadlines: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "headlines",
        value: [],
      };

      const finalCount: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        key: "count",
        value: 100,
      };

      processor.process(finalHeadlines);
      const result = processor.process(finalCount);

      expect(result.stateUpdates?.count).toBe(100);
      expect(result.isStateFinal).toBe(true);
    });
  });

  describe("sequence ordering", () => {
    it("processes in-order events immediately", () => {
      const event1: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 1,
      };

      const event2: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        key: "count",
        value: 2,
      };

      const result1 = processor.process(event1);
      const result2 = processor.process(event2);

      expect(result1.stateUpdates?.count).toBe(1);
      expect(result2.stateUpdates?.count).toBe(2);
    });

    it("buffers out-of-order events", () => {
      const event3: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e3",
        seq: 3,
        timestamp: Date.now(),
        key: "count",
        value: 3,
      };

      const result = processor.process(event3);

      expect(result.stateUpdates).toBeUndefined();
      expect(processor.getBufferSize()).toBe(1);
    });

    it("processes buffered events when gap is filled", () => {
      const event3: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e3",
        seq: 3,
        timestamp: Date.now(),
        key: "count",
        value: 3,
      };

      const event1: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 1,
      };

      const event2: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        key: "count",
        value: 2,
      };

      processor.process(event3);
      processor.process(event1);
      const result = processor.process(event2);

      expect(result.stateUpdates?.count).toBe(3);
      expect(processor.getBufferSize()).toBe(0);
    });

    it("calls onOutOfOrder callback", () => {
      const onOutOfOrder = vi.fn();
      processor = new UIEventProcessor<TestState>({ onOutOfOrder });

      const event3: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e3",
        seq: 3,
        timestamp: Date.now(),
        key: "count",
        value: 3,
      };

      processor.process(event3);

      expect(onOutOfOrder).toHaveBeenCalledWith(event3, 1);
    });
  });

  describe("content events", () => {
    it("creates text blocks from text events", () => {
      const event: UIContentTextEvent = {
        type: "ui:content:text",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        messageId: "m1",
        blockId: "b1",
        index: 0,
        text: "Hello world",
        final: false,
      };

      const result = processor.process(event);

      expect(result.messageBlocks).toHaveLength(1);
      expect(result.messageBlocks?.[0]).toEqual({
        type: "text",
        id: "b1",
        index: 0,
        text: "Hello world",
      });
    });

    it("creates structured blocks from structured events", () => {
      const event: UIContentStructuredEvent = {
        type: "ui:content:structured",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        messageId: "m1",
        blockId: "b1",
        index: 0,
        data: { foo: "bar" },
        sourceText: '{"foo":"bar"}',
        partial: false,
      };

      const result = processor.process(event);

      expect(result.messageBlocks).toHaveLength(1);
      expect(result.messageBlocks?.[0]).toEqual({
        type: "structured",
        id: "b1",
        index: 0,
        data: { foo: "bar" },
        sourceText: '{"foo":"bar"}',
        partial: false,
      });
    });

    it("creates reasoning blocks from reasoning events", () => {
      const event: UIContentReasoningEvent = {
        type: "ui:content:reasoning",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        messageId: "m1",
        blockId: "b1",
        index: 0,
        text: "Let me think...",
      };

      const result = processor.process(event);

      expect(result.messageBlocks).toHaveLength(1);
      expect(result.messageBlocks?.[0]).toEqual({
        type: "reasoning",
        id: "b1",
        index: 0,
        text: "Let me think...",
      });
    });

    it("updates existing blocks on subsequent events", () => {
      const event1: UIContentTextEvent = {
        type: "ui:content:text",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        messageId: "m1",
        blockId: "b1",
        index: 0,
        text: "Hello",
        final: false,
      };

      const event2: UIContentTextEvent = {
        type: "ui:content:text",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        messageId: "m1",
        blockId: "b1",
        index: 0,
        text: "Hello world",
        final: true,
      };

      processor.process(event1);
      processor.process(event2);

      const blocks = processor.getCurrentBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type === "text" && blocks[0].text).toBe("Hello world");
    });
  });

  describe("tool events", () => {
    it("creates pending tool on start", () => {
      const event: UIToolStartEvent = {
        type: "ui:tool:start",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        toolCallId: "tc1",
        toolName: "search",
      };

      const result = processor.process(event);

      expect(result.toolUpdates).toHaveLength(1);
      expect(result.toolUpdates?.[0]).toEqual({
        id: "tc1",
        name: "search",
        state: "pending",
      });
    });

    it("updates input on input event", () => {
      const startEvent: UIToolStartEvent = {
        type: "ui:tool:start",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        toolCallId: "tc1",
        toolName: "search",
      };

      const inputEvent: UIToolInputEvent = {
        type: "ui:tool:input",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        toolCallId: "tc1",
        input: { query: "test" },
        complete: true,
      };

      processor.process(startEvent);
      const result = processor.process(inputEvent);

      expect(result.toolUpdates?.[0]).toMatchObject({
        id: "tc1",
        input: { query: "test" },
        inputComplete: true,
        state: "running",
      });
    });

    it("marks complete on output event", () => {
      const startEvent: UIToolStartEvent = {
        type: "ui:tool:start",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        toolCallId: "tc1",
        toolName: "search",
      };

      const outputEvent: UIToolOutputEvent = {
        type: "ui:tool:output",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        toolCallId: "tc1",
        output: { results: ["a", "b"] },
      };

      processor.process(startEvent);
      const result = processor.process(outputEvent);

      expect(result.toolUpdates?.[0]).toMatchObject({
        id: "tc1",
        output: { results: ["a", "b"] },
        state: "complete",
      });
    });

    it("marks error on error event", () => {
      const startEvent: UIToolStartEvent = {
        type: "ui:tool:start",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        toolCallId: "tc1",
        toolName: "search",
      };

      const errorEvent: UIToolErrorEvent = {
        type: "ui:tool:error",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        toolCallId: "tc1",
        error: "Connection failed",
        retryable: true,
      };

      processor.process(startEvent);
      const result = processor.process(errorEvent);

      expect(result.toolUpdates?.[0]).toMatchObject({
        id: "tc1",
        error: "Connection failed",
        state: "error",
      });
    });

    it("ignores tool input without start", () => {
      const inputEvent: UIToolInputEvent = {
        type: "ui:tool:input",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        toolCallId: "tc1",
        input: { query: "test" },
        complete: true,
      };

      const result = processor.process(inputEvent);

      expect(result.toolUpdates).toEqual([]);
    });
  });

  describe("stream reset", () => {
    it("resets all state on new stream ID", () => {
      const event: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 1,
      };

      processor.process(event);
      processor.resetForNewStream("stream-1");
      processor.resetForNewStream("stream-2");

      expect(processor.getExpectedSeq()).toBe(1);
      expect(processor.getCurrentBlocks()).toHaveLength(0);
    });

    it("does not reset for same stream ID", () => {
      processor.resetForNewStream("stream-1");

      const event: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 1,
      };

      processor.process(event);
      processor.resetForNewStream("stream-1");

      expect(processor.getExpectedSeq()).toBe(2);
    });
  });

  describe("error handling", () => {
    it("calls onError callback on processing error", () => {
      const onError = vi.fn();
      processor = new UIEventProcessor<TestState>({ onError });

      const badEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "headlines",
        get value(): never {
          throw new Error("Test error");
        },
      };

      processor.process(badEvent);

      expect(onError).toHaveBeenCalled();
    });

    it("continues processing after error", () => {
      const onError = vi.fn();
      processor = new UIEventProcessor<TestState>({ onError });

      const badEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "headlines",
        get value(): never {
          throw new Error("Test error");
        },
      };

      const goodEvent: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        key: "count",
        value: 42,
      };

      processor.process(badEvent);
      const result = processor.process(goodEvent);

      expect(result.stateUpdates?.count).toBe(42);
    });
  });

  describe("non-UI events", () => {
    it("returns empty result for non-UI events", () => {
      const nonUIEvent = {
        type: "some:other:event",
        data: "foo",
      };

      const result = processor.process(nonUIEvent);

      expect(result).toEqual({});
    });

    it("does not throw for invalid events", () => {
      expect(() => processor.process(null)).not.toThrow();
      expect(() => processor.process(undefined)).not.toThrow();
      expect(() => processor.process("string")).not.toThrow();
      expect(() => processor.process(123)).not.toThrow();
      expect(() => processor.process({})).not.toThrow();
    });

    it("returns empty result for null/undefined", () => {
      expect(processor.process(null)).toEqual({});
      expect(processor.process(undefined)).toEqual({});
    });
  });

  describe("getCurrentBlocks", () => {
    it("returns blocks sorted by index", () => {
      const event1: UIContentTextEvent = {
        type: "ui:content:text",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        messageId: "m1",
        blockId: "b2",
        index: 1,
        text: "Second",
        final: false,
      };

      const event2: UIContentTextEvent = {
        type: "ui:content:text",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        messageId: "m1",
        blockId: "b1",
        index: 0,
        text: "First",
        final: false,
      };

      processor.process(event1);
      processor.process(event2);

      const blocks = processor.getCurrentBlocks();
      expect(blocks[0].index).toBe(0);
      expect(blocks[1].index).toBe(1);
    });
  });

  describe("getCurrentTools", () => {
    it("returns all tool states", () => {
      const start1: UIToolStartEvent = {
        type: "ui:tool:start",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        toolCallId: "tc1",
        toolName: "search",
      };

      const start2: UIToolStartEvent = {
        type: "ui:tool:start",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        toolCallId: "tc2",
        toolName: "calculate",
      };

      processor.process(start1);
      processor.process(start2);

      const tools = processor.getCurrentTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toContain("search");
      expect(tools.map((t) => t.name)).toContain("calculate");
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      const event: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "e1",
        seq: 1,
        timestamp: Date.now(),
        key: "count",
        value: 1,
      };

      const finalEvent: UIStateFinalEvent = {
        type: "ui:state:final",
        id: "e2",
        seq: 2,
        timestamp: Date.now(),
        key: "headlines",
        value: [],
      };

      processor.process(event);
      processor.process(finalEvent);
      processor.reset();

      expect(processor.getExpectedSeq()).toBe(1);
      expect(processor.isKeyFinalized("headlines")).toBe(false);
      expect(processor.getCurrentBlocks()).toHaveLength(0);
      expect(processor.getCurrentTools()).toHaveLength(0);
    });
  });
});
