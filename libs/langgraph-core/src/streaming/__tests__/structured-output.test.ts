import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { AIMessageChunk } from "@langchain/core/messages";
import { StreamingStructuredOutput } from "../structured-output.js";
import type { LangGraphRunnableConfig } from "../../pregel/runnable_types.js";

function createMockConfig(writer?: (chunk: unknown) => void): LangGraphRunnableConfig {
  return {
    writer: writer ?? vi.fn(),
    configurable: {
      checkpoint_id: "test-checkpoint-123",
      checkpoint_ns: "parent|child",
    },
  };
}

async function* createMockStream(
  chunks: string[]
): AsyncGenerator<AIMessageChunk> {
  for (const content of chunks) {
    yield new AIMessageChunk({ content });
  }
}

describe("StreamingStructuredOutput", () => {
  let emittedEvents: unknown[];
  let writer: (chunk: unknown) => void;
  let config: LangGraphRunnableConfig;

  beforeEach(() => {
    emittedEvents = [];
    writer = (chunk: unknown) => emittedEvents.push(chunk);
    config = createMockConfig(writer);
  });

  describe("basic JSON parsing", () => {
    it("parses single JSON block from stream", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream([
        "Here is the data:\n",
        "```json\n",
        '{"headlines": [{"text": "Sale"}]}',
        "\n```",
      ]);

      const result = await processor.processStream(stream);

      expect(result.parsed).toEqual({ headlines: [{ text: "Sale" }] });
      expect(result.blocks.some((b) => b.type === "structured")).toBe(true);
    });

    it("parses multiple JSON blocks", async () => {
      const processor = new StreamingStructuredOutput({
        target: "messages",
        config,
      });

      const stream = createMockStream([
        '```json\n{"first": 1}\n```\n',
        "Some text\n",
        '```json\n{"second": 2}\n```',
      ]);

      const result = await processor.processStream(stream);

      const structured = result.blocks.filter((b) => b.type === "structured");
      expect(structured.length).toBeGreaterThanOrEqual(1);
    });

    it("handles empty stream", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream([]);

      const result = await processor.processStream(stream);

      expect(result.parsed).toBeUndefined();
      expect(result.message.content).toBe("");
    });
  });

  describe("event emission", () => {
    it("emits ui:state:streaming for each state key change", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream([
        '```json\n{"headlines": [{"text": "A"}',
        ", ",
        '{"text": "B"}]}\n```',
      ]);

      await processor.processStream(stream);

      const streamingEvents = emittedEvents.filter(
        (e) => (e as { type: string }).type === "ui:state:streaming"
      );
      expect(streamingEvents.length).toBeGreaterThan(0);
    });

    it("emits ui:state:final at stream end", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream(['```json\n{"count": 42}\n```']);

      await processor.processStream(stream);

      const finalEvents = emittedEvents.filter(
        (e) => (e as { type: string }).type === "ui:state:final"
      );
      expect(finalEvents.length).toBeGreaterThan(0);
      expect((finalEvents[0] as { key: string; value: unknown }).key).toBe(
        "count"
      );
      expect((finalEvents[0] as { key: string; value: unknown }).value).toBe(
        42
      );
    });

    it("emits ui:content:structured for message blocks", async () => {
      const processor = new StreamingStructuredOutput({
        target: "messages",
        config,
      });

      const stream = createMockStream(['```json\n{"data": "test"}\n```']);

      await processor.processStream(stream);

      const structuredEvents = emittedEvents.filter(
        (e) => (e as { type: string }).type === "ui:content:structured"
      );
      expect(structuredEvents.length).toBeGreaterThan(0);
    });

    it("emits ui:content:text for non-JSON content", async () => {
      const processor = new StreamingStructuredOutput({
        target: "messages",
        config,
      });

      const stream = createMockStream([
        "Hello ",
        "world",
        '!\n```json\n{"x":1}\n```',
      ]);

      await processor.processStream(stream);

      const textEvents = emittedEvents.filter(
        (e) => (e as { type: string }).type === "ui:content:text"
      );
      expect(textEvents.length).toBeGreaterThan(0);
    });
  });

  describe("deduplication", () => {
    it("does not emit when value unchanged", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream([
        '```json\n{"count": 1}\n',
        "```",
      ]);

      await processor.processStream(stream);

      const countEvents = emittedEvents.filter(
        (e) =>
          (e as { type: string }).type === "ui:state:streaming" &&
          (e as { key: string }).key === "count"
      );
      expect(countEvents.length).toBe(1);
    });

    it("emits when value changes", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream([
        '```json\n{"items": [1',
        ", 2",
        ", 3]}\n```",
      ]);

      await processor.processStream(stream);

      const itemsEvents = emittedEvents.filter(
        (e) =>
          (e as { type: string }).type === "ui:state:streaming" &&
          (e as { key: string }).key === "items"
      );
      expect(itemsEvents.length).toBeGreaterThan(1);
    });
  });

  describe("transforms", () => {
    it("applies transforms to values before emission", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
        transforms: {
          count: (v) => (v as number) * 2,
        },
      });

      const stream = createMockStream(['```json\n{"count": 5}\n```']);

      await processor.processStream(stream);

      const finalEvent = emittedEvents.find(
        (e) =>
          (e as { type: string }).type === "ui:state:final" &&
          (e as { key: string }).key === "count"
      ) as { value: number } | undefined;

      expect(finalEvent?.value).toBe(10);
    });

    it("continues if transform errors", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
        transforms: {
          bad: () => {
            throw new Error("Transform error");
          },
          good: (v) => v,
        },
      });

      const stream = createMockStream([
        '```json\n{"bad": 1, "good": 2}\n```',
      ]);

      const result = await processor.processStream(stream);

      const goodEvent = emittedEvents.find(
        (e) =>
          (e as { type: string }).type === "ui:state:final" &&
          (e as { key: string }).key === "good"
      );
      expect(goodEvent).toBeDefined();
      expect(result.message).toBeDefined();
    });
  });

  describe("sequence numbers", () => {
    it("sequence numbers are monotonically increasing", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream([
        '```json\n{"a": 1, "b": 2, "c": 3}\n```',
      ]);

      await processor.processStream(stream);

      const seqs = emittedEvents.map((e) => (e as { seq: number }).seq);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    });

    it("sequence resets per instance", async () => {
      const stream1 = createMockStream(['```json\n{"x": 1}\n```']);
      const stream2 = createMockStream(['```json\n{"x": 1}\n```']);

      const events1: unknown[] = [];
      const events2: unknown[] = [];

      const processor1 = new StreamingStructuredOutput({
        target: "state",
        config: createMockConfig((e) => events1.push(e)),
      });

      const processor2 = new StreamingStructuredOutput({
        target: "state",
        config: createMockConfig((e) => events2.push(e)),
      });

      await processor1.processStream(stream1);
      await processor2.processStream(stream2);

      const seq1 = events1.map((e) => (e as { seq: number }).seq);
      const seq2 = events2.map((e) => (e as { seq: number }).seq);

      expect(seq1[0]).toBe(seq2[0]);
    });
  });

  describe("namespace handling", () => {
    it("includes namespace from checkpoint_ns", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream(['```json\n{"x": 1}\n```']);

      await processor.processStream(stream);

      const event = emittedEvents[0] as { namespace?: string[] };
      expect(event.namespace).toEqual(["parent", "child"]);
    });

    it("handles missing namespace gracefully", async () => {
      const configWithoutNs = createMockConfig(writer);
      delete configWithoutNs.configurable?.checkpoint_ns;

      const processor = new StreamingStructuredOutput({
        target: "state",
        config: configWithoutNs,
      });

      const stream = createMockStream(['```json\n{"x": 1}\n```']);

      await processor.processStream(stream);

      const event = emittedEvents[0] as { namespace?: string[] };
      expect(event.namespace).toBeUndefined();
    });
  });

  describe("final message", () => {
    it("stores parsed_blocks in response_metadata", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream(['```json\n{"x": 1}\n```']);

      const result = await processor.processStream(stream);

      expect(result.message.response_metadata?.parsed_blocks).toBeDefined();
      expect(Array.isArray(result.message.response_metadata?.parsed_blocks)).toBe(
        true
      );
    });

    it("content matches accumulated text", async () => {
      const processor = new StreamingStructuredOutput({
        target: "messages",
        config,
      });

      const stream = createMockStream([
        "Hello ",
        "world!\n",
        '```json\n{"x": 1}\n```',
      ]);

      const result = await processor.processStream(stream);

      expect(result.message.content).toBe('Hello world!\n```json\n{"x": 1}\n```');
    });
  });

  describe("schema validation", () => {
    it("validates against Zod schema when provided", async () => {
      const schema = z.object({
        count: z.number(),
        name: z.string(),
      });

      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
        schema,
      });

      const stream = createMockStream([
        '```json\n{"count": 42, "name": "test"}\n```',
      ]);

      const result = await processor.processStream(stream);

      expect(result.parsed).toEqual({ count: 42, name: "test" });
    });

    it("returns undefined parsed when validation fails", async () => {
      const schema = z.object({
        count: z.number(),
        name: z.string(),
      });

      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
        schema,
      });

      const stream = createMockStream([
        '```json\n{"count": "not a number"}\n```',
      ]);

      const result = await processor.processStream(stream);

      expect(result.parsed).toBeUndefined();
    });
  });

  describe("checkpoint handling", () => {
    it("includes checkpointId in final events", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      const stream = createMockStream(['```json\n{"x": 1}\n```']);

      await processor.processStream(stream);

      const finalEvent = emittedEvents.find(
        (e) => (e as { type: string }).type === "ui:state:final"
      ) as { checkpointId?: string } | undefined;

      expect(finalEvent?.checkpointId).toBe("test-checkpoint-123");
    });
  });

  describe("no writer", () => {
    it("handles missing writer gracefully", async () => {
      const configWithoutWriter: LangGraphRunnableConfig = {
        configurable: {},
      };

      const processor = new StreamingStructuredOutput({
        target: "state",
        config: configWithoutWriter,
      });

      const stream = createMockStream(['```json\n{"x": 1}\n```']);

      const result = await processor.processStream(stream);

      expect(result.parsed).toEqual({ x: 1 });
    });
  });

  describe("complex content types", () => {
    it("handles array content in chunks", async () => {
      const processor = new StreamingStructuredOutput({
        target: "state",
        config,
      });

      async function* complexStream(): AsyncGenerator<AIMessageChunk> {
        yield new AIMessageChunk({
          content: [{ type: "text", text: "```json\n" }],
        });
        yield new AIMessageChunk({
          content: [{ type: "text", text: '{"data": 1}' }],
        });
        yield new AIMessageChunk({
          content: [{ type: "text", text: "\n```" }],
        });
      }

      const result = await processor.processStream(complexStream());

      expect(result.parsed).toEqual({ data: 1 });
    });
  });
});
