import { describe, it, expect, beforeEach } from "vitest";
import { TextBlockParser, tryParseJson } from "../text-block-parser.js";

describe("TextBlockParser", () => {
  let parser: TextBlockParser;

  beforeEach(() => {
    parser = new TextBlockParser(0, "state");
  });

  describe("constructor", () => {
    it("initializes with default values", () => {
      expect(parser.messageBuffer).toBe("");
      expect(parser.hasSeenJsonStart).toBe(false);
      expect(parser.hasSeenJsonEnd).toBe(false);
      expect(parser.index).toBe(0);
    });

    it("accepts custom index", () => {
      const customParser = new TextBlockParser(5);
      expect(customParser.index).toBe(5);
    });

    it("accepts custom jsonBlocksTarget", () => {
      const messagesParser = new TextBlockParser(0, "messages");
      expect(messagesParser.jsonBlocksTarget).toBe("messages");
    });
  });

  describe("append", () => {
    it("appends text to buffer", () => {
      parser.append("Hello ");
      parser.append("World");
      expect(parser.getContent()).toBe("Hello World");
    });
  });

  describe("getStreamingText", () => {
    it("returns full text when no JSON block", () => {
      parser.append("Just some plain text");
      expect(parser.getStreamingText()).toBe("Just some plain text");
    });

    it("returns text before JSON block", () => {
      parser.append("Here is some text\n\n```json\n{\"key\": \"value\"}\n```");
      expect(parser.getStreamingText()).toBe("Here is some text");
    });

    it("handles partial JSON block markers", () => {
      parser.append("Some text`");
      expect(parser.getStreamingText()).toBe("Some text");

      parser = new TextBlockParser(0, "state");
      parser.append("Some text``");
      expect(parser.getStreamingText()).toBe("Some text");

      parser = new TextBlockParser(0, "state");
      parser.append("Some text```");
      expect(parser.getStreamingText()).toBe("Some text");

      parser = new TextBlockParser(0, "state");
      parser.append("Some text```j");
      expect(parser.getStreamingText()).toBe("Some text");
    });
  });

  describe("getPreamble", () => {
    it("returns text before JSON block", () => {
      parser.append("Preamble text\n\n```json\n{}\n```");
      expect(parser.getPreamble()).toBe("Preamble text");
    });

    it("returns undefined when no preamble", () => {
      parser.append("```json\n{}\n```");
      expect(parser.getPreamble()).toBeUndefined();
    });

    it("returns full text as preamble when no JSON", () => {
      parser.append("Just plain text");
      expect(parser.getPreamble()).toBe("Just plain text");
    });
  });

  describe("getPostscript", () => {
    it("returns text after JSON block", () => {
      parser.append("```json\n{}\n```\nPostscript text");
      expect(parser.getPostscript()).toBe("Postscript text");
    });

    it("returns undefined when no postscript", () => {
      parser.append("```json\n{}\n```");
      expect(parser.getPostscript()).toBeUndefined();
    });

    it("returns undefined when JSON not closed", () => {
      parser.append("```json\n{}");
      expect(parser.getPostscript()).toBeUndefined();
    });
  });

  describe("hasJsonStart", () => {
    it("returns false initially", () => {
      expect(parser.hasJsonStart()).toBe(false);
    });

    it("returns true when buffer contains ```json", () => {
      parser.append("Text\n```json\n{");
      expect(parser.hasJsonStart()).toBe(true);
    });

    it("returns true after parse sets flag", async () => {
      await parser.parse("```json\n{}");
      expect(parser.hasJsonStart()).toBe(true);
    });
  });

  describe("hasJsonEnd", () => {
    it("returns false initially", () => {
      expect(parser.hasJsonEnd()).toBe(false);
    });
  });

  describe("parse", () => {
    it("parses complete JSON block", async () => {
      const [success, result] = await parser.parse('{"key": "value"}');
      expect(success).toBe(true);
      expect(result).toEqual({ key: "value" });
    });

    it("resets JSON flags after complete block", async () => {
      await parser.parse('{"a": 1}');
      parser.hasSeenJsonStart = true;
      parser.hasSeenJsonEnd = true;
      await parser.parse('```json\n{"a": 1}\n```');
      expect(parser.hasSeenJsonStart).toBe(false);
      expect(parser.hasSeenJsonEnd).toBe(false);
    });
  });

  describe("tryParseStructured", () => {
    it("parses JSON from buffer", async () => {
      parser.append('{"headlines": [{"id": "h1", "text": "Test"}]}');
      const [success, result] = await parser.tryParseStructured();
      expect(success).toBe(true);
      expect(result).toEqual({
        headlines: [{ id: "h1", text: "Test" }],
      });
    });

    it("handles nested objects", async () => {
      parser.append('{"nested": {"deep": {"value": 42}}}');
      const [success, result] = await parser.tryParseStructured();
      expect(success).toBe(true);
      expect(result).toEqual({
        nested: { deep: { value: 42 } },
      });
    });

    it("handles arrays", async () => {
      parser.append('{"items": [1, 2, 3]}');
      const [success, result] = await parser.tryParseStructured();
      expect(success).toBe(true);
      expect(result).toEqual({ items: [1, 2, 3] });
    });
  });

  describe("getKeyId", () => {
    it("generates consistent IDs for same key", () => {
      const id1 = parser.getKeyId("headlines");
      const id2 = parser.getKeyId("headlines");
      expect(id1).toBe(id2);
    });

    it("generates different IDs for different keys", () => {
      const id1 = parser.getKeyId("headlines");
      const id2 = parser.getKeyId("descriptions");
      expect(id1).not.toBe(id2);
    });
  });
});

describe("tryParseJson", () => {
  it("parses valid JSON object", async () => {
    const result = await tryParseJson<{ key: string }>('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("returns undefined for non-object values", async () => {
    expect(await tryParseJson('"string"')).toBeUndefined();
    expect(await tryParseJson("123")).toBeUndefined();
    expect(await tryParseJson("null")).toBeUndefined();
  });

  it("returns undefined for objects with only _type_ key", async () => {
    expect(await tryParseJson('{"_type_": "test"}')).toBeUndefined();
  });

  it("handles complex nested structures", async () => {
    const json = '{"headlines": [{"id": "h1", "text": "Headline 1"}, {"id": "h2", "text": "Headline 2"}], "descriptions": [{"id": "d1", "text": "Description 1"}]}';
    const result = await tryParseJson<{
      headlines: Array<{ id: string; text: string }>;
      descriptions: Array<{ id: string; text: string }>;
    }>(json);
    expect(result?.headlines).toHaveLength(2);
    expect(result?.descriptions).toHaveLength(1);
  });
});

describe("structured data extraction scenarios", () => {
  describe("ads-like structured output", () => {
    interface AdsOutput {
      headlines: Array<{ id: string; text: string; status?: string }>;
      descriptions: Array<{ id: string; text: string }>;
    }

    it("extracts headlines and descriptions from JSON", async () => {
      const parser = new TextBlockParser<AdsOutput>(0, "state");
      const json = '{"headlines": [{"id": "h1", "text": "Best Coffee in Town", "status": "pending"}, {"id": "h2", "text": "Fresh Roasted Daily", "status": "pending"}], "descriptions": [{"id": "d1", "text": "Premium organic coffee"}]}';

      parser.append(json);
      const [success, result] = await parser.tryParseStructured();

      expect(success).toBe(true);
      expect(result?.headlines).toHaveLength(2);
      expect(result?.headlines[0]).toEqual({
        id: "h1",
        text: "Best Coffee in Town",
        status: "pending",
      });
      expect(result?.descriptions).toHaveLength(1);
    });

    it("extracts preamble, json, and postscript", async () => {
      const parser = new TextBlockParser<AdsOutput>(0, "state");
      const json = '{"headlines": [{"id": "h1", "text": "Best Coffee in Town", "status": "pending"}, {"id": "h2", "text": "Fresh Roasted Daily", "status": "pending"}], "descriptions": [{"id": "d1", "text": "Premium organic coffee"}]}';

      parser.append("Preamble text\n\n```json\n" + json + "\n```\nPostscript text");
      const [success, result] = await parser.tryParseStructured();
      const text = parser.getStreamingText();
      const postscript = parser.getPostscript();

      expect(text).toBe("Preamble text");
      expect(postscript).toBe("Postscript text");
      expect(success).toBe(true);
      expect(result?.headlines).toHaveLength(2);
      expect(result?.headlines[0]).toEqual({
        id: "h1",
        text: "Best Coffee in Town",
        status: "pending",
      });
      expect(result?.descriptions).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("handles empty JSON object", async () => {
      const parser = new TextBlockParser(0, "state");
      parser.append("{}");
      const [success, result] = await parser.tryParseStructured();
      expect(success).toBe(true);
      expect(result).toEqual({});
    });

    it("handles JSON with unicode characters", async () => {
      const parser = new TextBlockParser(0, "state");
      parser.append('{"text": "Hello 世界"}');
      const [success, result] = await parser.tryParseStructured();
      expect(success).toBe(true);
      expect(result).toEqual({ text: "Hello 世界" });
    });

    it("handles JSON with escaped quotes", async () => {
      const parser = new TextBlockParser(0, "state");
      parser.append('{"text": "Say \\"Hello\\""}');
      const [success, result] = await parser.tryParseStructured();
      expect(success).toBe(true);
      expect(result).toEqual({ text: 'Say "Hello"' });
    });
  });
});
