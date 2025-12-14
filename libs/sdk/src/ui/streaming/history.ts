import type {
  MessageWithBlocks,
  MessageBlock,
  TextBlock,
  StructuredBlock,
  ReasoningBlock,
  ParsedBlock,
} from "./types.js";

export interface ReconstructionOptions<TSchema = unknown> {
  validateSchema?: (data: unknown) => data is TSchema;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  index?: number;
}

export interface Message {
  id?: string;
  type: "human" | "ai" | "system" | "tool";
  content: string | ContentBlock[];
  response_metadata?: {
    parsed_blocks?: ParsedBlock[];
    [key: string]: unknown;
  };
  additional_kwargs?: Record<string, unknown>;
}

function getContentAsString(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("");
}

export function reconstructMessagesWithBlocks<TSchema = unknown>(
  messages: Message[],
  options: ReconstructionOptions<TSchema> = {}
): MessageWithBlocks<TSchema>[] {
  return messages
    .filter((m) => m.type === "human" || m.type === "ai")
    .map((message) => {
      const role = message.type === "human" ? "user" : "assistant";
      const id = message.id ?? crypto.randomUUID();

      const contentString = getContentAsString(message.content);

      if (role === "user") {
        return createUserMessage<TSchema>(id, contentString);
      }

      const parsedBlocks = extractParsedBlocks(message);
      if (parsedBlocks && parsedBlocks.length > 0) {
        return createFromParsedBlocks<TSchema>(id, parsedBlocks, options);
      }

      return reconstructFromContent<TSchema>(contentString, id);
    });
}

export function extractParsedBlocks(message: Message): ParsedBlock[] | undefined {
  return message.response_metadata?.parsed_blocks;
}

function createUserMessage<TSchema>(
  id: string,
  content: string
): MessageWithBlocks<TSchema> {
  return {
    id,
    role: "user",
    blocks: [
      {
        type: "text",
        id: crypto.randomUUID(),
        index: 0,
        text: content,
      },
    ],
  };
}

function createFromParsedBlocks<TSchema>(
  id: string,
  parsedBlocks: ParsedBlock[],
  options: ReconstructionOptions<TSchema>
): MessageWithBlocks<TSchema> {
  const blocks: MessageBlock<TSchema>[] = parsedBlocks.map((pb, idx) => {
    switch (pb.type) {
      case "text":
        return {
          type: "text",
          id: pb.id,
          index: pb.index ?? idx,
          text: pb.text ?? "",
        } as TextBlock;

      case "structured": {
        const {data} = pb;
        const isValid = options.validateSchema
          ? options.validateSchema(data)
          : true;

        return {
          type: "structured",
          id: pb.id,
          index: pb.index ?? idx,
          data: isValid ? (data as TSchema) : (data as unknown as TSchema),
          sourceText: pb.sourceText ?? "",
          partial: false,
        } as StructuredBlock<TSchema>;
      }

      case "reasoning":
        return {
          type: "reasoning",
          id: pb.id,
          index: pb.index ?? idx,
          text: pb.text ?? "",
        } as ReasoningBlock;

      default:
        return {
          type: "text",
          id: pb.id,
          index: pb.index ?? idx,
          text: pb.text ?? "",
        } as TextBlock;
    }
  });

  return {
    id,
    role: "assistant",
    blocks: blocks.sort((a, b) => a.index - b.index),
  };
}

export function reconstructFromContent<TSchema>(
  content: string,
  messageId: string
): MessageWithBlocks<TSchema> {
  const blocks: MessageBlock<TSchema>[] = [];
  let index = 0;

  const jsonBlockRegex = /```json\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = jsonBlockRegex.exec(content)) !== null) {
    const textBefore = content.slice(lastIndex, match.index).trim();
    if (textBefore) {
      blocks.push({
        type: "text",
        id: crypto.randomUUID(),
        index: index++,
        text: textBefore,
      });
    }

    const jsonContent = match[1].trim();
    try {
      const data = JSON.parse(jsonContent);
      blocks.push({
        type: "structured",
        id: crypto.randomUUID(),
        index: index++,
        data: data as TSchema,
        sourceText: jsonContent,
        partial: false,
      });
    } catch {
      blocks.push({
        type: "text",
        id: crypto.randomUUID(),
        index: index++,
        text: match[0],
      });
    }

    lastIndex = match.index + match[0].length;
  }

  const textAfter = content.slice(lastIndex).trim();
  if (textAfter) {
    blocks.push({
      type: "text",
      id: crypto.randomUUID(),
      index: index++,
      text: textAfter,
    });
  }

  if (blocks.length === 0) {
    blocks.push({
      type: "text",
      id: crypto.randomUUID(),
      index: 0,
      text: content,
    });
  }

  return {
    id: messageId,
    role: "assistant",
    blocks,
  };
}

export function extractStateFromHistory<
  TState extends Record<string, unknown>,
>(messages: Message[]): Partial<TState> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === "ai") {
      const parsedBlocks = extractParsedBlocks(message);
      if (parsedBlocks) {
        const state: Partial<TState> = {};
        for (const block of parsedBlocks) {
          if (block.type === "structured" && block.data) {
            Object.assign(state, block.data);
          }
        }
        return state;
      }
    }
  }
  return {};
}
