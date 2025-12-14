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

function strictParsePartialJson(s: string): unknown {
  const buffer = s.trim();
  if (buffer.length === 0) throw new Error("Unexpected end of JSON input");
  let pos = 0;

  function skipWhitespace(): void {
    while (pos < buffer.length && /\s/.test(buffer[pos])) pos += 1;
  }

  function parseString(): string {
    if (buffer[pos] !== '"')
      throw new Error(`Expected '"' at position ${pos}`);
    pos += 1;
    let result = "";
    let escaped = false;
    while (pos < buffer.length) {
      const char = buffer[pos];
      if (escaped) {
        if (char === "n") result += "\n";
        else if (char === "t") result += "\t";
        else if (char === "r") result += "\r";
        else if (char === "\\") result += "\\";
        else if (char === '"') result += '"';
        else if (char === "b") result += "\b";
        else if (char === "f") result += "\f";
        else if (char === "/") result += "/";
        else if (char === "u") {
          const hex = buffer.substring(pos + 1, pos + 5);
          if (/^[0-9A-Fa-f]{0,4}$/.test(hex)) {
            if (hex.length === 4)
              result += String.fromCharCode(Number.parseInt(hex, 16));
            else result += `u${hex}`;
            pos += hex.length;
          } else
            throw new Error(
              `Invalid unicode escape sequence '\\u${hex}' at position ${pos}`
            );
        } else
          throw new Error(
            `Invalid escape sequence '\\${char}' at position ${pos}`
          );
        escaped = false;
      } else if (char === "\\") escaped = true;
      else if (char === '"') {
        pos += 1;
        return result;
      } else result += char;
      pos += 1;
    }
    if (escaped) result += "\\";
    return result;
  }

  function parseNumber(): number {
    const start = pos;
    let numStr = "";
    if (buffer[pos] === "-") {
      numStr += "-";
      pos += 1;
    }
    if (pos < buffer.length && buffer[pos] === "0") {
      numStr += "0";
      pos += 1;
      if (buffer[pos] >= "0" && buffer[pos] <= "9")
        throw new Error(`Invalid number at position ${start}`);
    }
    if (pos < buffer.length && buffer[pos] >= "1" && buffer[pos] <= "9")
      while (
        pos < buffer.length &&
        buffer[pos] >= "0" &&
        buffer[pos] <= "9"
      ) {
        numStr += buffer[pos];
        pos += 1;
      }
    if (pos < buffer.length && buffer[pos] === ".") {
      numStr += ".";
      pos += 1;
      while (
        pos < buffer.length &&
        buffer[pos] >= "0" &&
        buffer[pos] <= "9"
      ) {
        numStr += buffer[pos];
        pos += 1;
      }
    }
    if (
      pos < buffer.length &&
      (buffer[pos] === "e" || buffer[pos] === "E")
    ) {
      numStr += buffer[pos];
      pos += 1;
      if (
        pos < buffer.length &&
        (buffer[pos] === "+" || buffer[pos] === "-")
      ) {
        numStr += buffer[pos];
        pos += 1;
      }
      while (
        pos < buffer.length &&
        buffer[pos] >= "0" &&
        buffer[pos] <= "9"
      ) {
        numStr += buffer[pos];
        pos += 1;
      }
    }
    if (numStr === "-") return -0;
    const num = Number.parseFloat(numStr);
    if (Number.isNaN(num)) {
      pos = start;
      throw new Error(`Invalid number '${numStr}' at position ${start}`);
    }
    return num;
  }

  function parseValue(): unknown {
    skipWhitespace();
    if (pos >= buffer.length)
      throw new Error(`Unexpected end of input at position ${pos}`);
    const char = buffer[pos];
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === '"') return parseString();
    if ("null".startsWith(buffer.substring(pos, pos + 4))) {
      pos += Math.min(4, buffer.length - pos);
      return null;
    }
    if ("true".startsWith(buffer.substring(pos, pos + 4))) {
      pos += Math.min(4, buffer.length - pos);
      return true;
    }
    if ("false".startsWith(buffer.substring(pos, pos + 5))) {
      pos += Math.min(5, buffer.length - pos);
      return false;
    }
    if (char === "-" || (char >= "0" && char <= "9")) return parseNumber();
    throw new Error(`Unexpected character '${char}' at position ${pos}`);
  }

  function parseArray(): unknown[] {
    if (buffer[pos] !== "[")
      throw new Error(`Expected '[' at position ${pos}`);
    const arr: unknown[] = [];
    pos += 1;
    skipWhitespace();
    if (pos >= buffer.length) return arr;
    if (buffer[pos] === "]") {
      pos += 1;
      return arr;
    }
    while (pos < buffer.length) {
      skipWhitespace();
      if (pos >= buffer.length) return arr;
      arr.push(parseValue());
      skipWhitespace();
      if (pos >= buffer.length) return arr;
      if (buffer[pos] === "]") {
        pos += 1;
        return arr;
      } else if (buffer[pos] === ",") {
        pos += 1;
        continue;
      }
      throw new Error(`Expected ',' or ']' at position ${pos}`);
    }
    return arr;
  }

  function parseObject(): Record<string, unknown> {
    if (buffer[pos] !== "{")
      throw new Error(`Expected '{' at position ${pos}`);
    const obj: Record<string, unknown> = {};
    pos += 1;
    skipWhitespace();
    if (pos >= buffer.length) return obj;
    if (buffer[pos] === "}") {
      pos += 1;
      return obj;
    }
    while (pos < buffer.length) {
      skipWhitespace();
      if (pos >= buffer.length) return obj;
      const key = parseString();
      skipWhitespace();
      if (pos >= buffer.length) return obj;
      if (buffer[pos] !== ":")
        throw new Error(`Expected ':' at position ${pos}`);
      pos += 1;
      skipWhitespace();
      if (pos >= buffer.length) return obj;
      obj[key] = parseValue();
      skipWhitespace();
      if (pos >= buffer.length) return obj;
      if (buffer[pos] === "}") {
        pos += 1;
        return obj;
      } else if (buffer[pos] === ",") {
        pos += 1;
        continue;
      }
      throw new Error(`Expected ',' or '}' at position ${pos}`);
    }
    return obj;
  }

  const value = parseValue();
  return value;
}

function parsePartialJsonCore(s: string): unknown | null {
  try {
    if (typeof s === "undefined") return null;
    return strictParsePartialJson(s);
  } catch {
    return null;
  }
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
    // ignore - try partial parsing
  }

  const partialValue = parsePartialJsonCore(trimmed);
  if (partialValue !== null) {
    return { value: partialValue, state: "partial" };
  }

  return { value: undefined, state: "error" };
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
