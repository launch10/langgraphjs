import { describe, it, expect } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { createBridge } from "../src/utils/index.mjs";

describe("createBridge", () => {
  type RawState = {
    headlines: string[];
    descriptions: string[];
  };

  type TransformedState = {
    headlines: { id: string; text: string; locked: boolean }[];
    descriptions: { id: string; text: string }[];
  }

  const bridge = createBridge<TransformedState>({
    jsonTarget: "state",
    transforms: {
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
    },
  });

  describe("applyTransforms", () => {
    it("should transform raw state to typed state", () => {
      const raw: RawState = {
        headlines: ["Buy Now", "Limited Time"],
        descriptions: ["Great deal", "Act fast"],
      };

      const transformed = bridge.applyTransforms(raw);

      expect(transformed.headlines).toEqual([
        { id: "h-0", text: "Buy Now", locked: false },
        { id: "h-1", text: "Limited Time", locked: false },
      ]);
      expect(transformed.descriptions).toEqual([
        { id: "d-0", text: "Great deal" },
        { id: "d-1", text: "Act fast" },
      ]);
    });

    it("should pass through untransformed keys", () => {
      const raw = {
        headlines: ["Test"],
        descriptions: ["Desc"],
        extra: "untouched",
      };

      const transformed = bridge.applyTransforms(raw);

      expect(transformed.headlines).toEqual([
        { id: "h-0", text: "Test", locked: false },
      ]);
      expect((transformed as any).extra).toBe("untouched");
    });
  });

  describe("toStructuredMessage", () => {
    it("should parse and transform JSON from message content", async () => {
      const message = new AIMessage({
        content: `Here's your ad copy:

\`\`\`json
{
  "headlines": ["Buy Now", "Save 50%"],
  "descriptions": ["Best deals online", "Free shipping"]
}
\`\`\``,
      });

      const [result, parsed] = await bridge.toStructuredMessage(message);

      expect(parsed).toEqual({
        headlines: [
          { id: "h-0", text: "Buy Now", locked: false },
          { id: "h-1", text: "Save 50%", locked: false },
        ],
        descriptions: [
          { id: "d-0", text: "Best deals online" },
          { id: "d-1", text: "Free shipping" },
        ],
      });

      expect(result.response_metadata?.parsed_blocks).toBeDefined();

      const textBlock = result.response_metadata?.parsed_blocks!.find(
        (block) => block.type === "text"
      );
      const structuredMessageBlock = result.response_metadata?.parsed_blocks?.find(
        (block) => block.type === "structured"
      );

      expect(result.content).toEqual(message.content);
      expect(textBlock).toBeDefined();
      expect(textBlock?.sourceText).toBe("Here's your ad copy:");
      expect(structuredMessageBlock).toBeDefined();
      expect(structuredMessageBlock.data).toEqual(parsed);
    });

    it("should return undefined parsed when no JSON block", async () => {
      const message = new AIMessage({
        content: "Just plain text without JSON",
      });

      const [, parsed] = await bridge.toStructuredMessage(message);

      expect(parsed).toBeUndefined();
    });
  });

  describe("bridge with messages target", () => {
    const messagesBridge = createBridge<{ data: string }>({
      jsonTarget: "messages",
    });

    it("should not extract state when target is messages", async () => {
      const message = new AIMessage({
        content: `\`\`\`json
{"data": "test"}
\`\`\``,
      });

      const [, parsed] = await messagesBridge.toStructuredMessage(message);

      expect(parsed).toBeUndefined();
    });
  });

  describe("bridge without transforms", () => {
    const noTransformsBridge = createBridge<RawState>({
      jsonTarget: "state",
    });

    it("should return raw values when no transforms defined", async () => {
      const message = new AIMessage({
        content: `\`\`\`json
{"headlines": ["Test"], "descriptions": ["Desc"]}
\`\`\``,
      });

      const [, parsed] = await noTransformsBridge.toStructuredMessage(message);

      expect(parsed).toEqual({
        headlines: ["Test"],
        descriptions: ["Desc"],
      });
    });
  });

  describe("bridge properties", () => {
    it("should expose jsonTarget", () => {
      expect(bridge.jsonTarget).toBe("state");
    });

    it("should expose transforms", () => {
      expect(bridge.transforms).toBeDefined();
      expect(bridge.transforms?.headlines).toBeInstanceOf(Function);
      expect(bridge.transforms?.descriptions).toBeInstanceOf(Function);
    });
  });
});
