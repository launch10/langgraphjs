import { v4 as uuidv4 } from "uuid";
import type { z } from "zod";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import type { AIMessageChunk } from "@langchain/core/messages";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { RobustTextBlockParser, type ParsedBlock } from "./parser.js";

export interface UIEventBase {
  type: string;
  id: string;
  seq: number;
  timestamp: number;
  namespace?: string[];
}

export interface UIStateStreamingEvent extends UIEventBase {
  type: "ui:state:streaming";
  key: string;
  value: unknown;
}

export interface UIStateFinalEvent extends UIEventBase {
  type: "ui:state:final";
  key: string;
  value: unknown;
  checkpointId?: string;
}

export interface UIContentTextEvent extends UIEventBase {
  type: "ui:content:text";
  messageId: string;
  blockId: string;
  index: number;
  text: string;
  final: boolean;
}

export interface UIContentStructuredEvent extends UIEventBase {
  type: "ui:content:structured";
  messageId: string;
  blockId: string;
  index: number;
  data: unknown;
  sourceText: string;
  partial: boolean;
}

export type UIEvent =
  | UIStateStreamingEvent
  | UIStateFinalEvent
  | UIContentTextEvent
  | UIContentStructuredEvent;

export interface StreamingStructuredOutputOptions<
  TSchema extends z.ZodType = z.ZodType,
> {
  schema?: TSchema;
  target: "messages" | "state";
  transforms?: Partial<Record<string, (value: unknown) => unknown>>;
  config: LangGraphRunnableConfig;
}

export interface ParseResult<TSchema extends z.ZodType = z.ZodType> {
  message: AIMessage;
  parsed: z.infer<TSchema> | undefined;
  blocks: ParsedBlock[];
}

export class StreamingStructuredOutput<
  TSchema extends z.ZodType = z.ZodType,
> {
  private parser: RobustTextBlockParser;
  private seq: number = 0;
  private lastEmitted: Map<string, string> = new Map();
  private options: StreamingStructuredOutputOptions<TSchema>;
  private messageId: string;
  private fullContent: string = "";
  private blockIndex: number = 0;
  private textBlockIndex: number = 0;

  constructor(options: StreamingStructuredOutputOptions<TSchema>) {
    this.options = options;
    this.parser = new RobustTextBlockParser();
    this.messageId = uuidv4();
  }

  async processStream(
    stream: AsyncIterable<AIMessageChunk>
  ): Promise<ParseResult<TSchema>> {
    for await (const chunk of stream) {
      const content =
        typeof chunk.content === "string"
          ? chunk.content
          : Array.isArray(chunk.content)
            ? chunk.content
                .filter(
                  (c): c is { type: "text"; text: string } => c.type === "text"
                )
                .map((c) => c.text)
                .join("")
            : "";

      if (content) {
        this.fullContent += content;
        this.parser.append(content);
        this.emitStreamingUpdates();
      }
    }

    this.emitFinalUpdates();

    const blocks = this.parser.getBlocks();
    const parsed = this.extractParsed(blocks);

    const message = new AIMessage({
      content: this.fullContent,
      response_metadata: {
        parsed_blocks: blocks,
      },
    });

    return {
      message,
      parsed,
      blocks,
    };
  }

  private emitStreamingUpdates(): void {
    this.emitTextStreamingUpdates();

    if (this.options.target === "state") {
      this.emitStateStreamingUpdates();
    } else {
      this.emitStructuredStreamingUpdates();
    }
  }

  private emitTextStreamingUpdates(): void {
    const text = this.parser.getStreamingText();
    if (text && this.shouldEmit("text", text)) {
      this.emit({
        type: "ui:content:text",
        id: uuidv4(),
        seq: this.nextSeq(),
        timestamp: Date.now(),
        namespace: this.getNamespace(),
        messageId: this.messageId,
        blockId: this.parser.textId,
        index: this.textBlockIndex,
        text,
        final: false,
      });
    }
  }

  private emitStateStreamingUpdates(): void {
    const partial = this.parser.tryParsePartialJson();
    if (!partial || typeof partial !== "object" || partial === null) {
      return;
    }

    for (const [key, value] of Object.entries(partial)) {
      let transformedValue = value;
      if (this.options.transforms?.[key]) {
        try {
          transformedValue = this.options.transforms[key](value);
        } catch {
          continue;
        }
      }

      if (this.shouldEmit(`state:${key}`, transformedValue)) {
        this.emit({
          type: "ui:state:streaming",
          id: uuidv4(),
          seq: this.nextSeq(),
          timestamp: Date.now(),
          namespace: this.getNamespace(),
          key,
          value: transformedValue,
        });
      }
    }
  }

  private emitStructuredStreamingUpdates(): void {
    if (this.parser.isInJsonBlock()) {
      const partial = this.parser.tryParsePartialJson();
      if (partial && this.shouldEmit("structured", partial)) {
        this.emit({
          type: "ui:content:structured",
          id: uuidv4(),
          seq: this.nextSeq(),
          timestamp: Date.now(),
          namespace: this.getNamespace(),
          messageId: this.messageId,
          blockId: this.parser.structuredId,
          index: this.blockIndex,
          data: partial,
          sourceText: this.parser.getJsonContent(),
          partial: true,
        });
      }
    }
  }

  private emitFinalUpdates(): void {
    this.emitTextFinalUpdate();

    if (this.options.target === "state") {
      this.emitStateFinalUpdates();
    } else {
      this.emitStructuredFinalUpdates();
    }
  }

  private emitTextFinalUpdate(): void {
    const text = this.parser.getStreamingText();
    if (text) {
      this.emit({
        type: "ui:content:text",
        id: uuidv4(),
        seq: this.nextSeq(),
        timestamp: Date.now(),
        namespace: this.getNamespace(),
        messageId: this.messageId,
        blockId: this.parser.textId,
        index: this.textBlockIndex,
        text,
        final: true,
      });
    }
  }

  private emitStateFinalUpdates(): void {
    const blocks = this.parser.getBlocks();
    const structured = blocks.find((b) => b.type === "structured");

    if (!structured?.data || typeof structured.data !== "object") {
      return;
    }

    const checkpointId = this.options.config.configurable?.checkpoint_id as
      | string
      | undefined;

    for (const [key, value] of Object.entries(structured.data)) {
      let transformedValue = value;
      if (this.options.transforms?.[key]) {
        try {
          transformedValue = this.options.transforms[key](value);
        } catch {
          continue;
        }
      }

      this.emit({
        type: "ui:state:final",
        id: uuidv4(),
        seq: this.nextSeq(),
        timestamp: Date.now(),
        namespace: this.getNamespace(),
        key,
        value: transformedValue,
        checkpointId,
      });
    }
  }

  private emitStructuredFinalUpdates(): void {
    const blocks = this.parser.getBlocks();
    for (const block of blocks) {
      if (block.type === "structured" && block.data) {
        this.blockIndex++;
        this.emit({
          type: "ui:content:structured",
          id: uuidv4(),
          seq: this.nextSeq(),
          timestamp: Date.now(),
          namespace: this.getNamespace(),
          messageId: this.messageId,
          blockId: block.id,
          index: this.blockIndex,
          data: block.data,
          sourceText: block.sourceText ?? "",
          partial: false,
        });
      }
    }
  }

  private extractParsed(blocks: ParsedBlock[]): z.infer<TSchema> | undefined {
    const structured = blocks.find((b) => b.type === "structured");
    if (!structured?.data) {
      return undefined;
    }

    if (this.options.schema) {
      try {
        return this.options.schema.parse(structured.data);
      } catch {
        return undefined;
      }
    }

    return structured.data as z.infer<TSchema>;
  }

  private emit(event: UIEvent): void {
    const writer = this.options.config.writer;
    if (writer) {
      writer(event);
    }
  }

  private shouldEmit(key: string, value: unknown): boolean {
    const serialized = JSON.stringify(value);
    if (this.lastEmitted.get(key) === serialized) {
      return false;
    }
    this.lastEmitted.set(key, serialized);
    return true;
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  private getNamespace(): string[] | undefined {
    const ns = this.options.config.configurable?.checkpoint_ns as
      | string
      | undefined;
    if (!ns) return undefined;
    return ns.split("|").filter(Boolean);
  }
}

export type MessageLike =
  | BaseMessage
  | { role: string; content: string };

function toBaseMessage(msg: MessageLike): BaseMessage {
  if ("_getType" in msg) {
    return msg as BaseMessage;
  }
  const plain = msg as { role: string; content: string };
  switch (plain.role) {
    case "user":
    case "human":
      return new HumanMessage(plain.content);
    case "assistant":
    case "ai":
      return new AIMessage(plain.content);
    case "system":
      return new SystemMessage(plain.content);
    default:
      return new HumanMessage(plain.content);
  }
}

export async function streamStructuredOutput<
  TSchema extends z.ZodType = z.ZodType,
>(
  model: BaseChatModel,
  messages: MessageLike[],
  options: StreamingStructuredOutputOptions<TSchema>
): Promise<ParseResult<TSchema>> {
  const baseMessages = messages.map(toBaseMessage);
  const stream = await model.stream(baseMessages);
  const processor = new StreamingStructuredOutput(options);
  return processor.processStream(stream);
}
