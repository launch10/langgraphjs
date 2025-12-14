import { v4 as uuidv4 } from "uuid";

export enum ParserState {
  Text = "Text",
  MaybeFence = "MaybeFence",
  FenceType = "FenceType",
  InJsonBlock = "InJsonBlock",
  MaybeEndFence = "MaybeEndFence",
  InOtherCodeBlock = "InOtherCodeBlock",
}

export interface ParsedBlock {
  type: "text" | "structured" | "reasoning";
  id: string;
  index: number;
  text?: string;
  data?: unknown;
  sourceText?: string;
}

interface JsonParseResult {
  value: unknown;
  state: "partial" | "complete" | "error";
}

function parsePartialJson(text: string): JsonParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { value: undefined, state: "partial" };
  }

  try {
    const value = JSON.parse(trimmed);
    return { value, state: "complete" };
  } catch {
    // ignore
  }

  try {
    const repaired = repairJson(trimmed);
    const value = JSON.parse(repaired);
    return { value, state: "partial" };
  } catch {
    return { value: undefined, state: "error" };
  }
}

function repairJson(text: string): string {
  let result = text;
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < result.length; i++) {
    const char = result[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") openBraces++;
    if (char === "}") openBraces--;
    if (char === "[") openBrackets++;
    if (char === "]") openBrackets--;
  }

  if (inString) {
    result += '"';
  }

  const lastNonWhitespace = result.trim().slice(-1);
  if (
    lastNonWhitespace !== "}" &&
    lastNonWhitespace !== "]" &&
    lastNonWhitespace !== '"' &&
    lastNonWhitespace !== "," &&
    openBraces > 0
  ) {
    if (result.includes(":")) {
      const colonIndex = result.lastIndexOf(":");
      const afterColon = result.slice(colonIndex + 1).trim();
      if (!afterColon || afterColon === "") {
        result += "null";
      }
    }
  }

  while (openBrackets > 0) {
    result += "]";
    openBrackets--;
  }

  while (openBraces > 0) {
    result += "}";
    openBraces--;
  }

  return result;
}

export class RobustTextBlockParser {
  static readonly BUFFER_LIMIT = 64 * 1024;

  readonly textId: string;
  readonly structuredId: string;

  private state: ParserState = ParserState.Text;
  private textBuffer = "";
  private jsonBuffer = "";
  private fenceBuffer = "";
  private fenceType = "";
  private backtickCount = 0;
  private endBacktickCount = 0;
  private blocks: ParsedBlock[] = [];
  private blockIndex = 0;
  private jsonComplete = false;
  private blockIds: Map<string, string> = new Map();

  constructor() {
    this.textId = uuidv4();
    this.structuredId = uuidv4();
  }

  append(text: string): void {
    for (const char of text) {
      this.processChar(char);
    }
    this.enforceBufferLimits();
  }

  private processChar(char: string): void {
    switch (this.state) {
      case ParserState.Text:
        this.handleTextState(char);
        break;
      case ParserState.MaybeFence:
        this.handleMaybeFenceState(char);
        break;
      case ParserState.FenceType:
        this.handleFenceTypeState(char);
        break;
      case ParserState.InJsonBlock:
        this.handleInJsonBlockState(char);
        break;
      case ParserState.MaybeEndFence:
        this.handleMaybeEndFenceState(char);
        break;
      case ParserState.InOtherCodeBlock:
        this.handleInOtherCodeBlockState(char);
        break;
    }
  }

  private handleTextState(char: string): void {
    if (char === "`") {
      this.state = ParserState.MaybeFence;
      this.backtickCount = 1;
      this.fenceBuffer = "`";
    } else {
      this.textBuffer += char;
    }
  }

  private handleMaybeFenceState(char: string): void {
    if (char === "`") {
      this.backtickCount++;
      this.fenceBuffer += char;
      if (this.backtickCount === 3) {
        this.state = ParserState.FenceType;
        this.fenceType = "";
      }
    } else {
      this.textBuffer += this.fenceBuffer + char;
      this.fenceBuffer = "";
      this.backtickCount = 0;
      this.state = ParserState.Text;
    }
  }

  private handleFenceTypeState(char: string): void {
    if (char === "\n") {
      const type = this.fenceType.trim().toLowerCase();
      if (type === "json") {
        this.state = ParserState.InJsonBlock;
        this.jsonBuffer = "";
        this.jsonComplete = false;
      } else {
        this.state = ParserState.InOtherCodeBlock;
      }
      this.fenceBuffer = "";
      this.fenceType = "";
    } else {
      this.fenceType += char;
    }
  }

  private handleInJsonBlockState(char: string): void {
    if (char === "`") {
      this.state = ParserState.MaybeEndFence;
      this.endBacktickCount = 1;
    } else {
      this.jsonBuffer += char;
    }
  }

  private handleMaybeEndFenceState(char: string): void {
    if (char === "`") {
      this.endBacktickCount++;
      if (this.endBacktickCount === 3) {
        this.finalizeJsonBlock();
        this.state = ParserState.Text;
        this.endBacktickCount = 0;
      }
    } else {
      this.jsonBuffer += "`".repeat(this.endBacktickCount) + char;
      this.endBacktickCount = 0;
      this.state = ParserState.InJsonBlock;
    }
  }

  private handleInOtherCodeBlockState(char: string): void {
    if (char === "`") {
      this.endBacktickCount++;
      if (this.endBacktickCount === 3) {
        this.state = ParserState.Text;
        this.endBacktickCount = 0;
      }
    } else {
      this.endBacktickCount = 0;
    }
  }

  private finalizeJsonBlock(): void {
    const trimmed = this.jsonBuffer.trim();
    if (trimmed) {
      const parseResult = parsePartialJson(trimmed);
      this.blocks.push({
        type: "structured",
        id: this.structuredId,
        index: this.blockIndex++,
        data: parseResult.value,
        sourceText: trimmed,
      });
      this.jsonComplete = true;
    }
    this.jsonBuffer = "";
  }

  getStreamingText(): string {
    if (this.state === ParserState.MaybeFence) {
      return this.textBuffer;
    }
    return this.textBuffer;
  }

  tryParsePartialJson(): unknown | undefined {
    if (!this.isInJsonBlock()) return undefined;
    const result = parsePartialJson(this.jsonBuffer);
    return result.value;
  }

  isInJsonBlock(): boolean {
    return (
      this.state === ParserState.InJsonBlock ||
      this.state === ParserState.MaybeEndFence
    );
  }

  isJsonComplete(): boolean {
    return this.jsonComplete;
  }

  getJsonContent(): string {
    return this.jsonBuffer;
  }

  getBlocks(): ParsedBlock[] {
    const result: ParsedBlock[] = [];

    const text = this.textBuffer.trim();
    if (text) {
      result.push({
        type: "text",
        id: this.textId,
        index: 0,
        text,
        sourceText: text,
      });
    }

    result.push(...this.blocks);
    return result.sort((a, b) => a.index - b.index);
  }

  getBlockId(key: string): string {
    if (!this.blockIds.has(key)) {
      this.blockIds.set(key, uuidv4());
    }
    return this.blockIds.get(key)!;
  }

  reset(): void {
    this.state = ParserState.Text;
    this.textBuffer = "";
    this.jsonBuffer = "";
    this.fenceBuffer = "";
    this.fenceType = "";
    this.backtickCount = 0;
    this.endBacktickCount = 0;
    this.blocks = [];
    this.blockIndex = 0;
    this.jsonComplete = false;
  }

  private enforceBufferLimits(): void {
    if (this.textBuffer.length > RobustTextBlockParser.BUFFER_LIMIT) {
      const trimPoint = this.findSafeTrimPoint(this.textBuffer);
      this.textBuffer = this.textBuffer.slice(trimPoint);
    }
    if (this.jsonBuffer.length > RobustTextBlockParser.BUFFER_LIMIT) {
      throw new Error("JSON block exceeds maximum size");
    }
  }

  private findSafeTrimPoint(buffer: string): number {
    const targetLength = Math.floor(
      RobustTextBlockParser.BUFFER_LIMIT * 0.75
    );
    const searchStart = buffer.length - targetLength;

    for (let i = searchStart; i < buffer.length; i++) {
      if (buffer[i] === "\n" || buffer[i] === " ") {
        return i + 1;
      }
    }

    return searchStart;
  }

  getState(): ParserState {
    return this.state;
  }
}
