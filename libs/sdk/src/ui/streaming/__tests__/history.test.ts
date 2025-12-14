import { describe, it, expect } from "vitest";
import {
  reconstructMessagesWithBlocks,
  extractParsedBlocks,
  reconstructFromContent,
  extractStateFromHistory,
  type Message,
} from "../history.js";
import type { ParsedBlock, TextBlock, StructuredBlock } from "../types.js";

describe("History Reconstruction", () => {
  describe("user messages", () => {
    it("converts to single text block", () => {
      const messages: Message[] = [
        { type: "human", content: "Hello world" },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result).toHaveLength(1);
      expect(result[0].blocks).toHaveLength(1);
      expect(result[0].blocks[0].type).toBe("text");
      expect((result[0].blocks[0] as TextBlock).text).toBe("Hello world");
    });

    it("sets role to user", () => {
      const messages: Message[] = [
        { type: "human", content: "Hello" },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result[0].role).toBe("user");
    });

    it("uses message ID if available", () => {
      const messages: Message[] = [
        { id: "msg-123", type: "human", content: "Hello" },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result[0].id).toBe("msg-123");
    });

    it("generates ID if not available", () => {
      const messages: Message[] = [
        { type: "human", content: "Hello" },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result[0].id).toBeDefined();
      expect(typeof result[0].id).toBe("string");
    });
  });

  describe("AI messages with parsed_blocks", () => {
    it("uses parsed_blocks from metadata", () => {
      const parsedBlocks: ParsedBlock[] = [
        { type: "text", id: "t1", index: 0, text: "Hello" },
        {
          type: "structured",
          id: "s1",
          index: 1,
          data: { count: 42 },
          sourceText: '{"count": 42}',
        },
      ];

      const messages: Message[] = [
        {
          type: "ai",
          content: 'Hello\n```json\n{"count": 42}\n```',
          response_metadata: { parsed_blocks: parsedBlocks },
        },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result).toHaveLength(1);
      expect(result[0].blocks).toHaveLength(2);
    });

    it("creates correct block types", () => {
      const parsedBlocks: ParsedBlock[] = [
        { type: "text", id: "t1", index: 0, text: "Text block" },
        {
          type: "structured",
          id: "s1",
          index: 1,
          data: { x: 1 },
          sourceText: '{"x": 1}',
        },
        { type: "reasoning", id: "r1", index: 2, text: "Reasoning block" },
      ];

      const messages: Message[] = [
        {
          type: "ai",
          content: "",
          response_metadata: { parsed_blocks: parsedBlocks },
        },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result[0].blocks[0].type).toBe("text");
      expect(result[0].blocks[1].type).toBe("structured");
      expect(result[0].blocks[2].type).toBe("reasoning");
    });

    it("maintains block order by index", () => {
      const parsedBlocks: ParsedBlock[] = [
        { type: "text", id: "t2", index: 2, text: "Third" },
        { type: "text", id: "t0", index: 0, text: "First" },
        { type: "text", id: "t1", index: 1, text: "Second" },
      ];

      const messages: Message[] = [
        {
          type: "ai",
          content: "",
          response_metadata: { parsed_blocks: parsedBlocks },
        },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect((result[0].blocks[0] as TextBlock).text).toBe("First");
      expect((result[0].blocks[1] as TextBlock).text).toBe("Second");
      expect((result[0].blocks[2] as TextBlock).text).toBe("Third");
    });
  });

  describe("AI messages without parsed_blocks", () => {
    it("falls back to re-parsing", () => {
      const messages: Message[] = [
        {
          type: "ai",
          content: 'Here is data:\n```json\n{"value": 1}\n```',
        },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result).toHaveLength(1);
      expect(result[0].blocks.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts JSON code blocks", () => {
      const messages: Message[] = [
        {
          type: "ai",
          content: '```json\n{"key": "value"}\n```',
        },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      const structured = result[0].blocks.find(
        (b) => b.type === "structured"
      ) as StructuredBlock;
      expect(structured).toBeDefined();
      expect(structured.data).toEqual({ key: "value" });
    });

    it("handles text before/after JSON", () => {
      const messages: Message[] = [
        {
          type: "ai",
          content: 'Before\n```json\n{"x": 1}\n```\nAfter',
        },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result[0].blocks.length).toBe(3);
      expect(result[0].blocks[0].type).toBe("text");
      expect(result[0].blocks[1].type).toBe("structured");
      expect(result[0].blocks[2].type).toBe("text");
    });
  });

  describe("schema validation", () => {
    it("validates structured blocks when validator provided", () => {
      interface MySchema {
        count: number;
      }

      const parsedBlocks: ParsedBlock[] = [
        {
          type: "structured",
          id: "s1",
          index: 0,
          data: { count: 42 },
          sourceText: '{"count": 42}',
        },
      ];

      const messages: Message[] = [
        {
          type: "ai",
          content: "",
          response_metadata: { parsed_blocks: parsedBlocks },
        },
      ];

      const result = reconstructMessagesWithBlocks<MySchema>(messages, {
        validateSchema: (data): data is MySchema =>
          typeof data === "object" &&
          data !== null &&
          typeof (data as MySchema).count === "number",
      });

      const structured = result[0].blocks[0] as StructuredBlock<MySchema>;
      expect(structured.data.count).toBe(42);
    });

    it("includes invalid blocks without throwing", () => {
      const parsedBlocks: ParsedBlock[] = [
        {
          type: "structured",
          id: "s1",
          index: 0,
          data: { invalid: "data" },
          sourceText: '{"invalid": "data"}',
        },
      ];

      const messages: Message[] = [
        {
          type: "ai",
          content: "",
          response_metadata: { parsed_blocks: parsedBlocks },
        },
      ];

      const result = reconstructMessagesWithBlocks(messages, {
        validateSchema: () => false,
      });

      expect(result[0].blocks).toHaveLength(1);
      expect(result[0].blocks[0].type).toBe("structured");
    });
  });

  describe("mixed message types", () => {
    it("filters out system/tool messages", () => {
      const messages: Message[] = [
        { type: "system", content: "System prompt" },
        { type: "human", content: "User message" },
        { type: "ai", content: "AI response" },
        { type: "tool", content: "Tool result" },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("user");
      expect(result[1].role).toBe("assistant");
    });

    it("handles alternating user/assistant", () => {
      const messages: Message[] = [
        { type: "human", content: "Question 1" },
        { type: "ai", content: "Answer 1" },
        { type: "human", content: "Question 2" },
        { type: "ai", content: "Answer 2" },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result).toHaveLength(4);
      expect(result[0].role).toBe("user");
      expect(result[1].role).toBe("assistant");
      expect(result[2].role).toBe("user");
      expect(result[3].role).toBe("assistant");
    });
  });

  describe("edge cases", () => {
    it("handles empty messages array", () => {
      const result = reconstructMessagesWithBlocks([]);
      expect(result).toEqual([]);
    });

    it("handles empty content", () => {
      const messages: Message[] = [{ type: "ai", content: "" }];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result).toHaveLength(1);
      expect(result[0].blocks).toHaveLength(1);
      expect((result[0].blocks[0] as TextBlock).text).toBe("");
    });

    it("handles malformed JSON in content", () => {
      const messages: Message[] = [
        { type: "ai", content: "```json\n{invalid json}\n```" },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      expect(result).toHaveLength(1);
      expect(result[0].blocks[0].type).toBe("text");
    });

    it("handles multiple JSON blocks", () => {
      const messages: Message[] = [
        {
          type: "ai",
          content:
            '```json\n{"first": 1}\n```\nMiddle\n```json\n{"second": 2}\n```',
        },
      ];

      const result = reconstructMessagesWithBlocks(messages);

      const structured = result[0].blocks.filter(
        (b) => b.type === "structured"
      ) as StructuredBlock[];
      expect(structured).toHaveLength(2);
      expect(structured[0].data).toEqual({ first: 1 });
      expect(structured[1].data).toEqual({ second: 2 });
    });
  });

  describe("extractParsedBlocks", () => {
    it("returns parsed_blocks from metadata", () => {
      const parsedBlocks: ParsedBlock[] = [
        { type: "text", id: "t1", index: 0, text: "Hello" },
      ];

      const message: Message = {
        type: "ai",
        content: "Hello",
        response_metadata: { parsed_blocks: parsedBlocks },
      };

      const result = extractParsedBlocks(message);

      expect(result).toEqual(parsedBlocks);
    });

    it("returns undefined if not present", () => {
      const message: Message = {
        type: "ai",
        content: "Hello",
      };

      const result = extractParsedBlocks(message);

      expect(result).toBeUndefined();
    });

    it("returns undefined if response_metadata missing", () => {
      const message: Message = {
        type: "ai",
        content: "Hello",
        response_metadata: {},
      };

      const result = extractParsedBlocks(message);

      expect(result).toBeUndefined();
    });
  });

  describe("reconstructFromContent", () => {
    it("handles content with no JSON", () => {
      const result = reconstructFromContent("Just plain text", "m1");

      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].type).toBe("text");
      expect((result.blocks[0] as TextBlock).text).toBe("Just plain text");
    });

    it("handles content with only JSON", () => {
      const result = reconstructFromContent('```json\n{"only": "json"}\n```', "m1");

      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].type).toBe("structured");
    });

    it("handles multiple JSON blocks", () => {
      const content = '```json\n{"a": 1}\n```\nText\n```json\n{"b": 2}\n```';
      const result = reconstructFromContent(content, "m1");

      const structured = result.blocks.filter((b) => b.type === "structured");
      expect(structured).toHaveLength(2);
    });

    it("sets correct message ID", () => {
      const result = reconstructFromContent("Text", "custom-id");
      expect(result.id).toBe("custom-id");
    });

    it("sets role to assistant", () => {
      const result = reconstructFromContent("Text", "m1");
      expect(result.role).toBe("assistant");
    });
  });

  describe("extractStateFromHistory", () => {
    it("extracts state from last AI message", () => {
      const messages: Message[] = [
        { type: "human", content: "Question" },
        {
          type: "ai",
          content: "",
          response_metadata: {
            parsed_blocks: [
              {
                type: "structured",
                id: "s1",
                index: 0,
                data: { count: 42, name: "test" },
              },
            ],
          },
        },
      ];

      const result = extractStateFromHistory<{ count: number; name: string }>(
        messages
      );

      expect(result).toEqual({ count: 42, name: "test" });
    });

    it("returns empty object if no parsed_blocks", () => {
      const messages: Message[] = [
        { type: "human", content: "Question" },
        { type: "ai", content: "Answer without parsed_blocks" },
      ];

      const result = extractStateFromHistory(messages);

      expect(result).toEqual({});
    });

    it("merges data from all structured blocks", () => {
      const messages: Message[] = [
        {
          type: "ai",
          content: "",
          response_metadata: {
            parsed_blocks: [
              {
                type: "structured",
                id: "s1",
                index: 0,
                data: { a: 1 },
              },
              {
                type: "text",
                id: "t1",
                index: 1,
                text: "Some text",
              },
              {
                type: "structured",
                id: "s2",
                index: 2,
                data: { b: 2 },
              },
            ],
          },
        },
      ];

      const result = extractStateFromHistory<{ a: number; b: number }>(messages);

      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("uses most recent AI message", () => {
      const messages: Message[] = [
        {
          type: "ai",
          content: "",
          response_metadata: {
            parsed_blocks: [
              { type: "structured", id: "s1", index: 0, data: { old: true } },
            ],
          },
        },
        { type: "human", content: "Follow up" },
        {
          type: "ai",
          content: "",
          response_metadata: {
            parsed_blocks: [
              { type: "structured", id: "s2", index: 0, data: { new: true } },
            ],
          },
        },
      ];

      const result = extractStateFromHistory(messages);

      expect(result).toEqual({ new: true });
    });

    it("handles empty messages array", () => {
      const result = extractStateFromHistory([]);
      expect(result).toEqual({});
    });
  });
});
