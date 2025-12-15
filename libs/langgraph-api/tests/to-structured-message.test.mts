import { describe, it, expect } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import {
  toStructuredMessage,
  type StateTransforms,
  runWithParsingContext,
  cacheStructuredData,
} from "../src/utils/index.mjs";

describe("toStructuredMessage", () => {
  describe("basic parsing", () => {
    it("should parse JSON block from message content", async () => {
      const message = new AIMessage({
        content: `Here's your data:

\`\`\`json
{
  "headlines": ["Hello", "World"],
  "count": 42
}
\`\`\`

Hope that helps!`,
      });

      const [result, parsed] = await toStructuredMessage<{
        headlines: string[];
        count: number;
      }>(message, "state");

      expect(parsed).toEqual({
        headlines: ["Hello", "World"],
        count: 42,
      });
      expect(result.response_metadata?.parsed_blocks).toHaveLength(3);
    });

    it("should return undefined parsed when no JSON block", async () => {
      const message = new AIMessage({
        content: "Just plain text without any JSON",
      });

      const [result, parsed] = await toStructuredMessage(message, "state");

      expect(parsed).toBeUndefined();
      expect(result.response_metadata?.parsed_blocks).toHaveLength(1);
      expect(result.response_metadata?.parsed_blocks[0].type).toBe("text");
    });
  });

  describe("with transforms", () => {
    interface RawOutput {
      headlines: string[];
      descriptions: string[];
    }

    interface Headline {
      id: string;
      text: string;
      locked: boolean;
    }

    interface Description {
      id: string;
      text: string;
    }

    interface TransformedOutput {
      headlines: Headline[];
      descriptions: Description[];
    }

    const transforms: StateTransforms<TransformedOutput> = {
      headlines: (raw) =>
        (raw as string[]).map((text, i) => ({
          id: `h-${i}`,
          text,
          locked: false,
        })),
      descriptions: (raw) =>
        (raw as string[]).map((text, i) => ({
          id: `d-${i}`,
          text,
        })),
    };

    it("should apply transforms to parsed JSON when target is state", async () => {
      const message = new AIMessage({
        content: `Generated content:

\`\`\`json
{
  "headlines": ["Buy Now", "Limited Offer"],
  "descriptions": ["Great product", "Amazing deal"]
}
\`\`\``,
      });

      const [result, parsed] = await toStructuredMessage<TransformedOutput>(
        message,
        "state",
        transforms
      );

      expect(parsed).toEqual({
        headlines: [
          { id: "h-0", text: "Buy Now", locked: false },
          { id: "h-1", text: "Limited Offer", locked: false },
        ],
        descriptions: [
          { id: "d-0", text: "Great product" },
          { id: "d-1", text: "Amazing deal" },
        ],
      });

      const structuredBlock = result.response_metadata?.parsed_blocks?.find(
        (b: { type: string }) => b.type === "structured"
      );
      expect(structuredBlock?.data).toEqual(parsed);
    });

    it("should pass through keys without transforms unchanged", async () => {
      const message = new AIMessage({
        content: `\`\`\`json
{
  "headlines": ["Test"],
  "descriptions": ["Desc"],
  "extra": "untransformed"
}
\`\`\``,
      });

      const [, parsed] = await toStructuredMessage<
        TransformedOutput & { extra: string }
      >(message, "state", transforms);

      expect(parsed?.headlines).toEqual([
        { id: "h-0", text: "Test", locked: false },
      ]);
      expect(parsed?.extra).toBe("untransformed");
    });

    it("should not apply transforms when target is messages", async () => {
      const message = new AIMessage({
        content: `\`\`\`json
{
  "headlines": ["Test"]
}
\`\`\``,
      });

      const [, parsed] = await toStructuredMessage<RawOutput>(
        message,
        "messages"
      );

      expect(parsed).toBeUndefined();
    });

    it("should handle empty transforms object", async () => {
      const message = new AIMessage({
        content: `\`\`\`json
{
  "headlines": ["Test"]
}
\`\`\``,
      });

      const [, parsed] = await toStructuredMessage<RawOutput>(
        message,
        "state",
        {}
      );

      expect(parsed).toEqual({ headlines: ["Test"] });
    });
  });

  describe("parsed blocks metadata", () => {
    it("should include text blocks for preamble and postscript", async () => {
      const message = new AIMessage({
        content: `Preamble text here.

\`\`\`json
{"data": "value"}
\`\`\`

Postscript text here.`,
      });

      const [result] = await toStructuredMessage(message, "state");
      const blocks = result.response_metadata?.parsed_blocks;

      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe("text");
      expect(blocks[0].sourceText).toBe("Preamble text here.");
      expect(blocks[1].type).toBe("structured");
      expect(blocks[2].type).toBe("text");
      expect(blocks[2].sourceText).toBe("Postscript text here.");
    });
  });

  describe("array content", () => {
    it("should handle message with array content blocks", async () => {
      const message = new AIMessage({
        content: [
          {
            type: "text" as const,
            text: `\`\`\`json
{"items": ["a", "b"]}
\`\`\``,
          },
        ],
      });

      const transforms: StateTransforms<{ items: { value: string }[] }> = {
        items: (raw) => (raw as string[]).map((value) => ({ value })),
      };

      const [, parsed] = await toStructuredMessage<{
        items: { value: string }[];
      }>(message, "state", transforms);

      expect(parsed).toEqual({
        items: [{ value: "a" }, { value: "b" }],
      });
    });
  });

  describe("caching with transforms", () => {
    interface TransformedItem {
      id: string;
      text: string;
    }

    interface TransformedState {
      items: TransformedItem[];
    }

    it("should return cached transformed data instead of re-transforming", async () => {
      const messageId = "test-msg-123";
      const message = new AIMessage({
        id: messageId,
        content: `\`\`\`json
{"items": ["apple", "banana"]}
\`\`\``,
      });

      const transformsWithRandomIds: StateTransforms<TransformedState> = {
        items: (raw) =>
          (raw as string[]).map((text) => ({
            id: crypto.randomUUID(),
            text,
          })),
      };

      await runWithParsingContext(async () => {
        const firstTransformed = {
          items: [
            { id: "cached-id-1", text: "apple" },
            { id: "cached-id-2", text: "banana" },
          ],
        };
        cacheStructuredData(messageId, firstTransformed);

        const [, parsed] = await toStructuredMessage<TransformedState>(
          message,
          "state",
          transformsWithRandomIds
        );

        expect(parsed?.items[0].id).toBe("cached-id-1");
        expect(parsed?.items[1].id).toBe("cached-id-2");
      });
    });

    it("should apply transforms when no cached data exists", async () => {
      const message = new AIMessage({
        id: "fresh-msg-456",
        content: `\`\`\`json
{"items": ["test"]}
\`\`\``,
      });

      let callCount = 0;
      const countingTransforms: StateTransforms<TransformedState> = {
        items: (raw) => {
          callCount++;
          return (raw as string[]).map((text, i) => ({
            id: `fresh-${i}`,
            text,
          }));
        },
      };

      await runWithParsingContext(async () => {
        const [, parsed] = await toStructuredMessage<TransformedState>(
          message,
          "state",
          countingTransforms
        );

        expect(callCount).toBe(1);
        expect(parsed?.items[0].id).toBe("fresh-0");
      });
    });

    it("should NOT call transforms when using cached data", async () => {
      const messageId = "no-transform-msg";
      const message = new AIMessage({
        id: messageId,
        content: `\`\`\`json
{"items": ["x"]}
\`\`\``,
      });

      let transformCalled = false;
      const trackingTransforms: StateTransforms<TransformedState> = {
        items: (raw) => {
          transformCalled = true;
          return (raw as string[]).map((text, i) => ({
            id: `should-not-see-${i}`,
            text,
          }));
        },
      };

      await runWithParsingContext(async () => {
        cacheStructuredData(messageId, {
          items: [{ id: "pre-cached", text: "x" }],
        });

        const [, parsed] = await toStructuredMessage<TransformedState>(
          message,
          "state",
          trackingTransforms
        );

        expect(transformCalled).toBe(false);
        expect(parsed?.items[0].id).toBe("pre-cached");
      });
    });

    it("should still transform when cache exists but target is messages", async () => {
      const messageId = "messages-target-msg";
      const message = new AIMessage({
        id: messageId,
        content: `\`\`\`json
{"items": ["y"]}
\`\`\``,
      });

      await runWithParsingContext(async () => {
        cacheStructuredData(messageId, {
          items: [{ id: "cached", text: "y" }],
        });

        const [, parsed] = await toStructuredMessage(message, "messages");

        expect(parsed).toBeUndefined();
      });
    });
  });
});
