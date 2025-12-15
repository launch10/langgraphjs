import { parsePartialJson } from "@ai-sdk/ui-utils";

export type JSONBlockBelongsTo = "messages" | "state";

export interface ParsedBlock {
  type: "text" | "tool_call" | "structured" | "reasoning" | "image";
  index: number;
  id: string;
  sourceText?: string;
  parsed?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
}

function extractJson(text: string): {
  preamble?: string;
  json?: string;
  postscript?: string;
} {
  const jsonStart = text.indexOf("```json");
  if (jsonStart === -1) {
    return { preamble: text.trim() };
  }

  const afterStart = jsonStart + "```json".length;
  const jsonEnd = text.indexOf("```", afterStart);

  return {
    preamble: text.substring(0, jsonStart).trim() || undefined,
    json: text.substring(afterStart, jsonEnd === -1 ? undefined : jsonEnd).trim(),
    postscript:
      jsonEnd !== -1 ? text.substring(jsonEnd + 3).trim() || undefined : undefined,
  };
}

export async function tryParseJson<T>(
  text: string
): Promise<T | undefined> {
  try {
    const { json } = extractJson(text);
    const parseResult = await parsePartialJson(json || text);
    const parsed = parseResult.value;

    if (!parsed || typeof parsed !== "object") return undefined;
    if (Object.keys(parsed as object).length === 1 && "_type_" in (parsed as object))
      return undefined;

    return parsed as T;
  } catch {
    return undefined;
  }
}

export class TextBlockParser<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  messageBuffer: string = "";
  hasSeenJsonStart: boolean = false;
  hasSeenJsonEnd: boolean = false;
  index: number;
  id: string;
  textId: string;
  structuredId: string;
  hasEmittedPreamble: boolean = false;
  keyIds: Map<string, string> = new Map();
  jsonBlocksTarget: JSONBlockBelongsTo;

  constructor(index: number = 0, jsonBlocksTarget: JSONBlockBelongsTo = "messages") {
    this.index = index;
    this.id = crypto.randomUUID();
    this.textId = crypto.randomUUID();
    this.structuredId = crypto.randomUUID();
    this.jsonBlocksTarget = jsonBlocksTarget;
  }

  getKeyId(key: string): string {
    if (!this.keyIds.has(key)) this.keyIds.set(key, crypto.randomUUID());
    return this.keyIds.get(key)!;
  }

  append(text: string): void {
    this.messageBuffer += text;
  }

  getContent(): string {
    return this.messageBuffer;
  }

  getPreamble(): string | undefined {
    return extractJson(this.messageBuffer).preamble;
  }

  getStreamingText(): string {
    const jsonStart = this.messageBuffer.indexOf("```json");
    if (jsonStart === -1) {
      const partialMatch = this.messageBuffer.match(/`{1,2}$|```?j?o?s?o?$/);
      if (partialMatch) {
        return this.messageBuffer.substring(0, partialMatch.index);
      }
      return this.messageBuffer;
    }
    return this.messageBuffer.substring(0, jsonStart).trimEnd();
  }

  getPostscript(): string | undefined {
    return extractJson(this.messageBuffer).postscript;
  }

  hasJsonStart(): boolean {
    return this.hasSeenJsonStart || this.messageBuffer.includes("```json");
  }

  hasJsonEnd(): boolean {
    return this.hasSeenJsonEnd;
  }

  async parse(text: string): Promise<[boolean, Record<string, unknown> | undefined]> {
    this.append(text);

    if (this.messageBuffer.includes("```json")) {
      const indexOfJsonStart = this.messageBuffer.indexOf("```json");
      this.messageBuffer = this.messageBuffer.substring(
        indexOfJsonStart + "```json".length
      );
      this.hasSeenJsonStart = true;
    }
    if (this.hasSeenJsonStart && this.messageBuffer.includes("```")) {
      this.messageBuffer = this.messageBuffer.replace(/```/g, "");
      this.hasSeenJsonEnd = true;
    }
    if (this.hasSeenJsonStart && this.hasSeenJsonEnd) {
      this.hasSeenJsonStart = false;
      this.hasSeenJsonEnd = false;
    }

    const result = await tryParseJson(this.messageBuffer);
    return [!!result, result as Record<string, unknown> | undefined];
  }

  async tryParseStructured(): Promise<[boolean, TSchema | undefined]> {
    const result = await tryParseJson<TSchema>(this.messageBuffer);
    return [!!result, result];
  }
}
