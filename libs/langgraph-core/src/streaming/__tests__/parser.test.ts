import { describe, it, expect, beforeEach } from "vitest";
import { RobustTextBlockParser, ParserState } from "../parser.js";

describe("RobustTextBlockParser", () => {
  let parser: RobustTextBlockParser;

  beforeEach(() => {
    parser = new RobustTextBlockParser();
  });

  describe("basic JSON extraction", () => {
    it("extracts JSON from simple code block", () => {
      parser.append('Here is the data:\n```json\n{"name": "Alice"}\n```\nDone!');

      const blocks = parser.getBlocks();
      expect(blocks).toHaveLength(2);

      const textBlock = blocks.find((b) => b.type === "text");
      const structuredBlock = blocks.find((b) => b.type === "structured");

      expect(textBlock?.text).toContain("Here is the data:");
      expect(structuredBlock?.data).toEqual({ name: "Alice" });
    });

    it("handles block with just json type", () => {
      parser.append('```json\n{"value": 123}\n```');

      const blocks = parser.getBlocks();
      const structured = blocks.find((b) => b.type === "structured");
      expect(structured?.data).toEqual({ value: 123 });
    });

    it("handles block with JSON (case insensitive)", () => {
      parser.append('```JSON\n{"value": 456}\n```');

      const blocks = parser.getBlocks();
      const structured = blocks.find((b) => b.type === "structured");
      expect(structured?.data).toEqual({ value: 456 });
    });

    it("handles empty stream", () => {
      parser.append("");
      expect(parser.getBlocks()).toHaveLength(0);
    });
  });

  describe("streaming scenarios", () => {
    it("handles fence split across chunks", () => {
      parser.append("Here is data:\n`");
      expect(parser.getState()).toBe(ParserState.MaybeFence);

      parser.append("``json\n{");
      expect(parser.getState()).toBe(ParserState.InJsonBlock);
    });

    it("handles JSON split across chunks", () => {
      parser.append('```json\n{"name":');
      expect(parser.isInJsonBlock()).toBe(true);

      parser.append(' "Alice"}\n```');
      expect(parser.isJsonComplete()).toBe(true);

      const blocks = parser.getBlocks();
      const structured = blocks.find((b) => b.type === "structured");
      expect(structured?.data).toEqual({ name: "Alice" });
    });

    it("handles end fence split across chunks", () => {
      parser.append('```json\n{"value": 1}\n`');
      expect(parser.isInJsonBlock()).toBe(true);

      parser.append("``");
      expect(parser.isJsonComplete()).toBe(true);
    });
  });

  describe("safe streaming text", () => {
    it("excludes partial fence from streaming text", () => {
      parser.append("Hello world`");
      expect(parser.getStreamingText()).toBe("Hello world");
    });

    it("includes confirmed text only", () => {
      parser.append("Hello ");
      expect(parser.getStreamingText()).toBe("Hello ");

      parser.append("world");
      expect(parser.getStreamingText()).toBe("Hello world");
    });
  });

  describe("partial JSON parsing", () => {
    it("parses incomplete JSON objects", () => {
      parser.append('```json\n{"name": "Al');
      const partial = parser.tryParsePartialJson();
      expect(partial).toEqual({ name: "Al" });
    });

    it("parses incomplete arrays", () => {
      parser.append('```json\n[1, 2, 3');
      const partial = parser.tryParsePartialJson();
      expect(partial).toEqual([1, 2, 3]);
    });

    it("returns undefined for invalid JSON", () => {
      parser.append("```json\n{{{invalid");
      const partial = parser.tryParsePartialJson();
      expect(partial).toBeUndefined();
    });

    it("returns undefined when not in JSON block", () => {
      parser.append("Just some text");
      expect(parser.tryParsePartialJson()).toBeUndefined();
    });
  });

  describe("nested code blocks", () => {
    it("handles JSON containing escaped backticks in strings", () => {
      const jsonWithCode = '{"example": "code with backticks"}';
      parser.append("```json\n" + jsonWithCode + "\n```");

      const blocks = parser.getBlocks();
      const structured = blocks.find((b) => b.type === "structured");
      expect(structured?.data).toEqual({
        example: "code with backticks",
      });
    });
  });

  describe("buffer limits", () => {
    it("trims text buffer at safe points", () => {
      const longText = "word ".repeat(20000);
      parser.append(longText);

      expect(parser.getStreamingText().length).toBeLessThanOrEqual(
        RobustTextBlockParser.BUFFER_LIMIT
      );
    });

    it("throws error for oversized JSON", () => {
      parser.append("```json\n{");

      const largeContent = '"data": "' + "x".repeat(70000) + '"';
      expect(() => parser.append(largeContent)).toThrow(
        "JSON block exceeds maximum size"
      );
    });
  });

  describe("multiple blocks", () => {
    it("handles multiple JSON blocks in sequence", () => {
      parser.append('```json\n{"first": 1}\n```\nMiddle text\n```json\n{"second": 2}\n```');

      const blocks = parser.getBlocks();
      const structured = blocks.filter((b) => b.type === "structured");

      expect(structured).toHaveLength(2);
      expect(structured[0].data).toEqual({ first: 1 });
      expect(structured[1].data).toEqual({ second: 2 });
    });

    it("assigns correct indices to blocks", () => {
      parser.append('```json\n{"a": 1}\n```\nText\n```json\n{"b": 2}\n```');

      const blocks = parser.getBlocks();
      const structured = blocks.filter((b) => b.type === "structured");
      expect(structured[0].index).toBeLessThan(structured[1].index);
    });
  });

  describe("block IDs", () => {
    it("generates stable IDs", () => {
      const id1 = parser.getBlockId("key1");
      const id2 = parser.getBlockId("key1");
      expect(id1).toBe(id2);
    });

    it("same key returns same ID within session", () => {
      const id1 = parser.getBlockId("headlines");
      const id2 = parser.getBlockId("headlines");
      const id3 = parser.getBlockId("descriptions");

      expect(id1).toBe(id2);
      expect(id1).not.toBe(id3);
    });

    it("generates unique IDs for different keys", () => {
      const id1 = parser.getBlockId("key1");
      const id2 = parser.getBlockId("key2");
      expect(id1).not.toBe(id2);
    });
  });

  describe("edge cases", () => {
    it("handles empty input", () => {
      parser.append("");
      expect(parser.getBlocks()).toHaveLength(0);
      expect(parser.getStreamingText()).toBe("");
    });

    it("handles only text (no code blocks)", () => {
      parser.append("Just some regular text without any code blocks.");

      const blocks = parser.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      expect(blocks[0].text).toBe(
        "Just some regular text without any code blocks."
      );
    });

    it("handles only code block (no text)", () => {
      parser.append('```json\n{"only": "json"}\n```');

      const blocks = parser.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("structured");
    });

    it("handles unclosed code block", () => {
      parser.append('```json\n{"incomplete": true');

      expect(parser.isInJsonBlock()).toBe(true);
      expect(parser.isJsonComplete()).toBe(false);

      const partial = parser.tryParsePartialJson();
      expect(partial).toEqual({ incomplete: true });
    });

    it("handles non-json code blocks", () => {
      parser.append(
        "```python\nprint('hello')\n```\nSome text\n```json\n{\"value\": 1}\n```"
      );

      const blocks = parser.getBlocks();
      const structured = blocks.filter((b) => b.type === "structured");

      expect(structured).toHaveLength(1);
      expect(structured[0].data).toEqual({ value: 1 });
    });

    it("handles backticks in text that are not code fences", () => {
      parser.append("Use `code` for inline code and ``double`` for escaping");

      expect(parser.getState()).toBe(ParserState.Text);
      expect(parser.getStreamingText()).toContain("`code`");
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      parser.append('```json\n{"test": 1}\n```');
      expect(parser.getBlocks()).toHaveLength(1);

      parser.reset();

      expect(parser.getBlocks()).toHaveLength(0);
      expect(parser.getStreamingText()).toBe("");
      expect(parser.isInJsonBlock()).toBe(false);
      expect(parser.getState()).toBe(ParserState.Text);
    });
  });

  describe("textId and structuredId", () => {
    it("provides stable IDs for text and structured blocks", () => {
      expect(parser.textId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(parser.structuredId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(parser.textId).not.toBe(parser.structuredId);
    });
  });

  describe("complex JSON structures", () => {
    it("handles nested objects and arrays", () => {
      const complex = {
        headlines: [
          { text: "Hello", status: "pending" },
          { text: "World", status: "approved" },
        ],
        metadata: {
          count: 2,
          nested: { deep: { value: true } },
        },
      };

      parser.append("```json\n" + JSON.stringify(complex) + "\n```");

      const blocks = parser.getBlocks();
      const structured = blocks.find((b) => b.type === "structured");
      expect(structured?.data).toEqual(complex);
    });

    it("handles arrays with mixed types", () => {
      const mixed = [1, "two", { three: 3 }, [4, 5], null, true];

      parser.append("```json\n" + JSON.stringify(mixed) + "\n```");

      const blocks = parser.getBlocks();
      const structured = blocks.find((b) => b.type === "structured");
      expect(structured?.data).toEqual(mixed);
    });
  });
});
