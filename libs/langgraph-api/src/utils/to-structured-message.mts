import { AIMessage, AIMessageChunk, BaseMessage, ContentBlock } from "@langchain/core/messages";
import { parsePartialJson } from "@ai-sdk/ui-utils";
import type { JSONBlockBelongsTo, ParsedBlock } from "./text-block-parser.mjs";
import { getCachedStructuredData } from "./parsing-context.mjs";

export type ToStructuredMessageResult<TSchema = unknown> = 
  [AIMessage | AIMessageChunk, TSchema];

export type StateTransforms<TState> = {
  [K in keyof TState]?: (raw: unknown) => TState[K];
};

function applyTransforms<TSchema>(
  parsed: Record<string, unknown>,
  transforms?: StateTransforms<TSchema>
): TSchema {
  if (!transforms) return parsed as TSchema;
  
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const transform = transforms[key as keyof TSchema] as ((raw: unknown) => unknown) | undefined;
    result[key] = transform ? transform(value) : value;
  }
  return result as TSchema;
}

const isAIMessageChunk = (message: BaseMessage): message is AIMessageChunk => {
  return message.constructor.name === "AIMessageChunk";
};

const isTextBlock = (block: ContentBlock): block is ContentBlock.Text => block.type === "text";
const isToolCallBlock = (block: ContentBlock): block is ContentBlock.Tools.ToolCall => block.type === "tool_call";
const isToolCallChunkBlock = (block: ContentBlock): block is ContentBlock.Tools.ToolCallChunk => block.type === "tool_call_chunk";
const isImageBlock = (block: ContentBlock): block is ContentBlock.Multimodal.Image => block.type === "image";
const isReasoningBlock = (block: ContentBlock): block is ContentBlock.Reasoning => block.type === "reasoning";

function extractJson(text: string): { preamble?: string; json?: string; postscript?: string } {
  const jsonStart = text.indexOf("```json");
  if (jsonStart === -1) {
    return { preamble: text.trim() };
  }

  const afterStart = jsonStart + "```json".length;
  const jsonEnd = text.indexOf("```", afterStart);
  
  return {
    preamble: text.substring(0, jsonStart).trim(),
    json: text.substring(afterStart, jsonEnd === -1 ? undefined : jsonEnd).trim(),
    postscript: jsonEnd !== -1 ? text.substring(jsonEnd + 3).trim() || undefined : undefined,
  };
}

async function tryParseJson<T>(
  text: string, 
  _target: JSONBlockBelongsTo
): Promise<T | undefined> {
  try {
    const { json } = extractJson(text);
    const parseResult = await parsePartialJson(json || text);
    const parsed = parseResult.value;
    
    if (!parsed || typeof parsed !== "object") return undefined;
    if (Object.keys(parsed).length === 1 && "_type_" in parsed) return undefined;

    return parsed as T;
  } catch {
    return undefined;
  }
}

function createParsedBlock(type: ParsedBlock["type"], index: number, extras: Partial<ParsedBlock> = {}): ParsedBlock {
  return { type, index, id: crypto.randomUUID(), ...extras };
}

function buildMessage<T extends AIMessage | AIMessageChunk>(
  original: BaseMessage,
  content: string | ContentBlock[],
  parsedBlocks: ParsedBlock[]
): T {
  const metadata = {
    ...original.response_metadata,
    parsed_blocks: parsedBlocks.length > 0 ? parsedBlocks : undefined,
  };

  const baseProps = {
    content,
    id: original.id,
    response_metadata: metadata,
    additional_kwargs: original.additional_kwargs,
  };

  if (isAIMessageChunk(original)) {
    return new AIMessageChunk({
      ...baseProps,
      tool_calls: original.tool_calls,
      tool_call_chunks: original.tool_call_chunks,
      invalid_tool_calls: original.invalid_tool_calls,
      usage_metadata: original.usage_metadata,
    }) as T;
  }

  const m = original as AIMessage;
  return new AIMessage({
    ...baseProps,
    tool_calls: m.tool_calls,
    invalid_tool_calls: m.invalid_tool_calls,
    usage_metadata: m.usage_metadata,
  }) as T;
}

async function parseStringContent<TSchema>(
  message: BaseMessage,
  target: JSONBlockBelongsTo,
  transforms?: StateTransforms<TSchema>
): Promise<ToStructuredMessageResult<TSchema | undefined>> {
  const content = message.content as string;
  
  const cached = message.id ? getCachedStructuredData(message.id) : undefined;
  if (cached && target === "state") {
    const transformed = applyTransforms<TSchema>(cached.data as Record<string, unknown>, transforms);
    const { preamble, postscript } = extractJson(content);
    const blocks: ParsedBlock[] = [];
    let idx = 0;
    if (preamble) blocks.push(createParsedBlock("text", idx++, { sourceText: preamble }));
    blocks.push(createParsedBlock("structured", idx++, { sourceText: content, data: transformed as Record<string, unknown> }));
    if (postscript) blocks.push(createParsedBlock("text", idx++, { sourceText: postscript }));
    return [buildMessage(message, content, blocks), transformed];
  }

  const parsed = await tryParseJson<TSchema>(content, target);
  
  if (!parsed) {
    const blocks = [createParsedBlock("text", 0, { sourceText: content })];
    return [buildMessage(message, content, blocks), undefined];
  }

  const { preamble, postscript } = extractJson(content);
  const blocks: ParsedBlock[] = [];
  let idx = 0;

  const transformed = target === "state" 
    ? applyTransforms<TSchema>(parsed as Record<string, unknown>, transforms) 
    : parsed;

  if (preamble) blocks.push(createParsedBlock("text", idx++, { sourceText: preamble }));
  blocks.push(createParsedBlock("structured", idx++, { sourceText: content, data: transformed as Record<string, unknown> }));
  if (postscript) blocks.push(createParsedBlock("text", idx++, { sourceText: postscript }));

  const extractedState = target === "state" ? transformed : undefined;
  return [buildMessage(message, content, blocks), extractedState as TSchema | undefined];
}

async function parseArrayContent<TSchema>(
  message: BaseMessage,
  target: JSONBlockBelongsTo,
  transforms?: StateTransforms<TSchema>
): Promise<ToStructuredMessageResult<TSchema | undefined>> {
  const nativeContent: ContentBlock[] = [];
  const parsedBlocks: ParsedBlock[] = [];
  let extractedState: TSchema | undefined;

  for (let idx = 0; idx < message.content.length; idx++) {
    const block = message.content[idx] as ContentBlock;

    if (isToolCallBlock(block) || isToolCallChunkBlock(block) || isReasoningBlock(block) || isImageBlock(block)) {
      nativeContent.push(block);
      if (isToolCallBlock(block)) {
        parsedBlocks.push(createParsedBlock("tool_call", idx, {
          toolCallId: block.id,
          toolName: block.name,
          toolArgs: JSON.stringify(block.input),
        }));
      }
      continue;
    }

    if (!isTextBlock(block)) {
      nativeContent.push(block);
      continue;
    }

    const parsed = await tryParseJson<TSchema>(block.text, target);
    
    if (!parsed) {
      nativeContent.push(block);
      parsedBlocks.push(createParsedBlock("text", idx, { sourceText: block.text }));
      continue;
    }

    const { preamble } = extractJson(block.text);
    if (preamble) parsedBlocks.push(createParsedBlock("text", idx, { sourceText: preamble }));

    const transformed = target === "state"
      ? applyTransforms<TSchema>(parsed as Record<string, unknown>, transforms)
      : parsed;

    parsedBlocks.push(createParsedBlock("structured", idx + 1, { sourceText: block.text, data: transformed as Record<string, unknown> }));
    if (target === "state") {
      extractedState = transformed as TSchema;
    }

    nativeContent.push({ type: "text", text: block.text, index: block.index ?? 0, id: block.id ?? crypto.randomUUID() } as ContentBlock.Text);
  }

  return [buildMessage(message, nativeContent, parsedBlocks), extractedState];
}

type ResultType = BaseMessage | AIMessage | AIMessageChunk;

export async function toStructuredMessage<TSchema = unknown>(
  result: ResultType,
  jsonBlocksTarget?: "messages"
): Promise<ToStructuredMessageResult<undefined>>;

export async function toStructuredMessage<TSchema = unknown>(
  result: ResultType,
  jsonBlocksTarget: "state",
  transforms?: StateTransforms<TSchema>
): Promise<ToStructuredMessageResult<TSchema | undefined>>;

export async function toStructuredMessage<TSchema = unknown>(
  result: ResultType,
  jsonBlocksTarget: "messages" | "state" = "messages",
  transforms?: StateTransforms<TSchema>
): Promise<ToStructuredMessageResult<TSchema | undefined> | ToStructuredMessageResult<undefined>> {
  if (typeof result.content === "string") {
    return parseStringContent<TSchema>(result, jsonBlocksTarget, transforms);
  }
  if (!result.content || !Array.isArray(result.content)) {
    return [result as AIMessage, undefined];
  }
  return parseArrayContent<TSchema>(result, jsonBlocksTarget, transforms);
}
