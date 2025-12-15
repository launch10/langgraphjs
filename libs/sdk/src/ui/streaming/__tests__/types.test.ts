import { describe, it, expect, beforeEach } from "vitest";
import {
  isUIEvent,
  isUIContentTextEvent,
  isUIContentStructuredEvent,
  isUIContentReasoningEvent,
  isUIStateStreamingEvent,
  isUIStateFinalEvent,
  isUIToolStartEvent,
  isUIToolInputEvent,
  isUIToolOutputEvent,
  isUIToolErrorEvent,
  createUIEventId,
  nextSequence,
  resetSequence,
  type UIContentTextEvent,
  type UIContentStructuredEvent,
  type UIStateStreamingEvent,
  type TextBlock,
  type StructuredBlock,
  type MessageWithBlocks,
  type ToolState,
} from "../types.js";

describe("UI Event Types", () => {
  describe("isUIEvent", () => {
    it("returns true for valid UI events", () => {
      const event: UIContentTextEvent = {
        type: "ui:content:text",
        id: "123",
        seq: 1,
        timestamp: Date.now(),
        messageId: "msg-1",
        blockId: "block-1",
        index: 0,
        text: "Hello",
        final: false,
      };
      expect(isUIEvent(event)).toBe(true);
    });

    it("returns false for non-objects", () => {
      expect(isUIEvent(null)).toBe(false);
      expect(isUIEvent(undefined)).toBe(false);
      expect(isUIEvent("string")).toBe(false);
      expect(isUIEvent(123)).toBe(false);
      expect(isUIEvent(true)).toBe(false);
    });

    it("returns false for objects without type", () => {
      expect(isUIEvent({ id: "123", seq: 1 })).toBe(false);
    });

    it("returns false for objects with non-string type", () => {
      expect(isUIEvent({ type: 123 })).toBe(false);
      expect(isUIEvent({ type: null })).toBe(false);
    });

    it("returns false for objects with non-ui: type prefix", () => {
      expect(isUIEvent({ type: "other:event" })).toBe(false);
      expect(isUIEvent({ type: "custom" })).toBe(false);
      expect(isUIEvent({ type: "event" })).toBe(false);
    });

    it("returns true for all UI event types", () => {
      const eventTypes = [
        "ui:content:text",
        "ui:content:structured",
        "ui:content:reasoning",
        "ui:state:streaming",
        "ui:state:final",
        "ui:tool:start",
        "ui:tool:input",
        "ui:tool:output",
        "ui:tool:error",
      ];

      for (const type of eventTypes) {
        expect(isUIEvent({ type, id: "1", seq: 1, timestamp: 0 })).toBe(true);
      }
    });
  });

  describe("specific event type guards", () => {
    const baseEvent = {
      id: "123",
      seq: 1,
      timestamp: Date.now(),
    };

    it("isUIContentTextEvent identifies text events", () => {
      const event = {
        ...baseEvent,
        type: "ui:content:text",
        messageId: "msg-1",
        blockId: "block-1",
        index: 0,
        text: "Hello",
        final: false,
      };
      expect(isUIContentTextEvent(event)).toBe(true);
      expect(isUIContentTextEvent({ ...event, type: "ui:content:structured" })).toBe(false);
    });

    it("isUIContentStructuredEvent identifies structured events", () => {
      const event = {
        ...baseEvent,
        type: "ui:content:structured",
        messageId: "msg-1",
        blockId: "block-1",
        index: 0,
        data: { foo: "bar" },
        sourceText: '{"foo":"bar"}',
        partial: false,
      };
      expect(isUIContentStructuredEvent(event)).toBe(true);
      expect(isUIContentStructuredEvent({ ...event, type: "ui:content:text" })).toBe(false);
    });

    it("isUIContentReasoningEvent identifies reasoning events", () => {
      const event = {
        ...baseEvent,
        type: "ui:content:reasoning",
        messageId: "msg-1",
        blockId: "block-1",
        index: 0,
        text: "Thinking...",
      };
      expect(isUIContentReasoningEvent(event)).toBe(true);
      expect(isUIContentReasoningEvent({ ...event, type: "ui:content:text" })).toBe(false);
    });

    it("isUIStateStreamingEvent identifies state streaming events", () => {
      const event = {
        ...baseEvent,
        type: "ui:state:streaming",
        key: "headlines",
        value: [{ text: "Hello" }],
      };
      expect(isUIStateStreamingEvent(event)).toBe(true);
      expect(isUIStateStreamingEvent({ ...event, type: "ui:state:final" })).toBe(false);
    });

    it("isUIStateFinalEvent identifies state final events", () => {
      const event = {
        ...baseEvent,
        type: "ui:state:final",
        key: "headlines",
        value: [{ text: "Hello" }],
        checkpointId: "checkpoint-1",
      };
      expect(isUIStateFinalEvent(event)).toBe(true);
      expect(isUIStateFinalEvent({ ...event, type: "ui:state:streaming" })).toBe(false);
    });

    it("isUIToolStartEvent identifies tool start events", () => {
      const event = {
        ...baseEvent,
        type: "ui:tool:start",
        toolCallId: "tool-1",
        toolName: "search",
      };
      expect(isUIToolStartEvent(event)).toBe(true);
      expect(isUIToolStartEvent({ ...event, type: "ui:tool:input" })).toBe(false);
    });

    it("isUIToolInputEvent identifies tool input events", () => {
      const event = {
        ...baseEvent,
        type: "ui:tool:input",
        toolCallId: "tool-1",
        input: { query: "hello" },
        complete: false,
      };
      expect(isUIToolInputEvent(event)).toBe(true);
      expect(isUIToolInputEvent({ ...event, type: "ui:tool:start" })).toBe(false);
    });

    it("isUIToolOutputEvent identifies tool output events", () => {
      const event = {
        ...baseEvent,
        type: "ui:tool:output",
        toolCallId: "tool-1",
        output: { result: "world" },
      };
      expect(isUIToolOutputEvent(event)).toBe(true);
      expect(isUIToolOutputEvent({ ...event, type: "ui:tool:error" })).toBe(false);
    });

    it("isUIToolErrorEvent identifies tool error events", () => {
      const event = {
        ...baseEvent,
        type: "ui:tool:error",
        toolCallId: "tool-1",
        error: "Something went wrong",
        retryable: true,
      };
      expect(isUIToolErrorEvent(event)).toBe(true);
      expect(isUIToolErrorEvent({ ...event, type: "ui:tool:output" })).toBe(false);
    });
  });

  describe("sequence helpers", () => {
    beforeEach(() => {
      resetSequence();
    });

    it("nextSequence returns monotonically increasing numbers", () => {
      expect(nextSequence()).toBe(1);
      expect(nextSequence()).toBe(2);
      expect(nextSequence()).toBe(3);
    });

    it("resetSequence resets the counter", () => {
      expect(nextSequence()).toBe(1);
      expect(nextSequence()).toBe(2);
      resetSequence();
      expect(nextSequence()).toBe(1);
    });
  });

  describe("createUIEventId", () => {
    it("returns a valid UUID", () => {
      const id = createUIEventId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it("returns unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(createUIEventId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("type serialization", () => {
    it("UI events serialize and deserialize correctly via JSON", () => {
      const event: UIContentTextEvent = {
        type: "ui:content:text",
        id: "123",
        seq: 1,
        timestamp: 1234567890,
        messageId: "msg-1",
        blockId: "block-1",
        index: 0,
        text: "Hello world",
        final: true,
        namespace: ["parent", "child"],
      };

      const serialized = JSON.stringify(event);
      const deserialized = JSON.parse(serialized);

      expect(deserialized).toEqual(event);
      expect(isUIContentTextEvent(deserialized)).toBe(true);
    });

    it("structured events with complex data serialize correctly", () => {
      const event: UIContentStructuredEvent = {
        type: "ui:content:structured",
        id: "123",
        seq: 1,
        timestamp: 1234567890,
        messageId: "msg-1",
        blockId: "block-1",
        index: 0,
        data: {
          headlines: [
            { text: "Hello", status: "pending" },
            { text: "World", status: "approved" },
          ],
          nested: { deep: { value: 123 } },
        },
        sourceText: '{"headlines":[...]}',
        partial: false,
      };

      const serialized = JSON.stringify(event);
      const deserialized = JSON.parse(serialized);

      expect(deserialized).toEqual(event);
    });

    it("state events serialize correctly", () => {
      const event: UIStateStreamingEvent = {
        type: "ui:state:streaming",
        id: "123",
        seq: 1,
        timestamp: 1234567890,
        key: "headlines",
        value: [{ text: "Hello", id: "h1" }],
        namespace: ["subgraph"],
      };

      const serialized = JSON.stringify(event);
      const deserialized = JSON.parse(serialized);

      expect(deserialized).toEqual(event);
      expect(isUIStateStreamingEvent(deserialized)).toBe(true);
    });
  });

  describe("Block types", () => {
    it("TextBlock has correct structure", () => {
      const block: TextBlock = {
        type: "text",
        id: "block-1",
        index: 0,
        text: "Hello world",
      };
      expect(block.type).toBe("text");
    });

    it("StructuredBlock supports generic schema type", () => {
      interface MySchema {
        headlines: { text: string; status: string }[];
      }

      const block: StructuredBlock<MySchema> = {
        type: "structured",
        id: "block-1",
        index: 0,
        data: {
          headlines: [{ text: "Hello", status: "pending" }],
        },
        sourceText: '{"headlines":[...]}',
        partial: false,
      };

      expect(block.data.headlines[0].text).toBe("Hello");
    });
  });

  describe("MessageWithBlocks", () => {
    it("supports user messages", () => {
      const message: MessageWithBlocks = {
        id: "msg-1",
        role: "user",
        blocks: [
          {
            type: "text",
            id: "block-1",
            index: 0,
            text: "Hello",
          },
        ],
      };
      expect(message.role).toBe("user");
      expect(message.blocks.length).toBe(1);
    });

    it("supports assistant messages with mixed blocks", () => {
      const message: MessageWithBlocks = {
        id: "msg-1",
        role: "assistant",
        blocks: [
          {
            type: "text",
            id: "block-1",
            index: 0,
            text: "Here is your data:",
          },
          {
            type: "structured",
            id: "block-2",
            index: 1,
            data: { value: 123 },
            sourceText: '{"value":123}',
            partial: false,
          },
          {
            type: "tool_call",
            id: "block-3",
            index: 2,
            toolCallId: "tool-1",
            toolName: "search",
            state: "complete",
            input: { query: "hello" },
            output: { result: "world" },
          },
        ],
        raw: { original: "message" },
      };

      expect(message.blocks.length).toBe(3);
      expect(message.blocks[0].type).toBe("text");
      expect(message.blocks[1].type).toBe("structured");
      expect(message.blocks[2].type).toBe("tool_call");
    });
  });

  describe("ToolState", () => {
    it("supports all tool states", () => {
      const states: ToolState[] = [
        { id: "1", name: "search", state: "pending" },
        { id: "2", name: "search", state: "running", input: { q: "test" } },
        {
          id: "3",
          name: "search",
          state: "complete",
          input: { q: "test" },
          inputComplete: true,
          output: { result: "found" },
        },
        {
          id: "4",
          name: "search",
          state: "error",
          error: "Network timeout",
        },
      ];

      expect(states.every((s) => ["pending", "running", "complete", "error"].includes(s.state))).toBe(true);
    });
  });
});
