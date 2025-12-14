import type {
  UIEvent,
  UIStateStreamingEvent,
  UIStateFinalEvent,
  UIContentTextEvent,
  UIContentStructuredEvent,
  UIContentReasoningEvent,
  UIToolStartEvent,
  UIToolInputEvent,
  UIToolOutputEvent,
  UIToolErrorEvent,
  MessageBlock,
  ToolState,
  TextBlock,
  StructuredBlock,
  ReasoningBlock,
  ToolCallBlock,
} from "./types.js";
import { isUIEvent } from "./types.js";

export interface ProcessedResult<TState extends Record<string, unknown>> {
  stateUpdates?: Partial<TState>;
  messageBlocks?: MessageBlock[];
  toolUpdates?: ToolState[];
  isStateFinal?: boolean;
}

export interface UIEventProcessorOptions {
  onOutOfOrder?: (event: UIEvent, expected: number) => void;
  onError?: (error: Error, event: UIEvent) => void;
}

export class UIEventProcessor<
  TState extends Record<string, unknown> = Record<string, unknown>,
> {
  private options: UIEventProcessorOptions;
  private expectedSeq: number = 1;
  private buffer: Map<number, UIEvent> = new Map();
  private finalizedKeys: Set<keyof TState> = new Set();
  private blocks: Map<string, MessageBlock> = new Map();
  private tools: Map<string, ToolState> = new Map();
  private currentStreamId: string | undefined;

  constructor(options: UIEventProcessorOptions = {}) {
    this.options = options;
  }

  process(event: unknown): ProcessedResult<TState> {
    if (!isUIEvent(event)) {
      return {};
    }

    if (event.seq !== this.expectedSeq) {
      this.buffer.set(event.seq, event);
      this.options.onOutOfOrder?.(event, this.expectedSeq);
      return this.processBuffered();
    }

    this.expectedSeq++;
    const result = this.processEvent(event);

    const bufferedResults = this.processBuffered();
    return this.mergeResults(result, bufferedResults);
  }

  private processEvent(event: UIEvent): ProcessedResult<TState> {
    try {
      switch (event.type) {
        case "ui:state:streaming":
          return this.processStateStreaming(event as UIStateStreamingEvent);
        case "ui:state:final":
          return this.processStateFinal(event as UIStateFinalEvent);
        case "ui:content:text":
          return this.processContentText(event as UIContentTextEvent);
        case "ui:content:structured":
          return this.processContentStructured(
            event as UIContentStructuredEvent
          );
        case "ui:content:reasoning":
          return this.processContentReasoning(event as UIContentReasoningEvent);
        case "ui:tool:start":
          return this.processToolStart(event as UIToolStartEvent);
        case "ui:tool:input":
          return this.processToolInput(event as UIToolInputEvent);
        case "ui:tool:output":
          return this.processToolOutput(event as UIToolOutputEvent);
        case "ui:tool:error":
          return this.processToolError(event as UIToolErrorEvent);
        default:
          return {};
      }
    } catch (error) {
      this.options.onError?.(error as Error, event);
      return {};
    }
  }

  private processStateStreaming(
    event: UIStateStreamingEvent
  ): ProcessedResult<TState> {
    const key = event.key as keyof TState;

    if (this.finalizedKeys.has(key)) {
      return {};
    }

    return {
      stateUpdates: { [key]: event.value } as Partial<TState>,
    };
  }

  private processStateFinal(event: UIStateFinalEvent): ProcessedResult<TState> {
    const key = event.key as keyof TState;
    this.finalizedKeys.add(key);

    return {
      stateUpdates: { [key]: event.value } as Partial<TState>,
      isStateFinal: true,
    };
  }

  private processContentText(
    event: UIContentTextEvent
  ): ProcessedResult<TState> {
    const block: TextBlock = {
      type: "text",
      id: event.blockId,
      index: event.index,
      text: event.text,
    };

    this.blocks.set(event.blockId, block);

    return {
      messageBlocks: [block],
    };
  }

  private processContentStructured(
    event: UIContentStructuredEvent
  ): ProcessedResult<TState> {
    const block: StructuredBlock = {
      type: "structured",
      id: event.blockId,
      index: event.index,
      data: event.data,
      sourceText: event.sourceText,
      partial: event.partial,
    };

    this.blocks.set(event.blockId, block);

    return {
      messageBlocks: [block],
    };
  }

  private processContentReasoning(
    event: UIContentReasoningEvent
  ): ProcessedResult<TState> {
    const block: ReasoningBlock = {
      type: "reasoning",
      id: event.blockId,
      index: event.index,
      text: event.text,
    };

    this.blocks.set(event.blockId, block);

    return {
      messageBlocks: [block],
    };
  }

  private processToolStart(event: UIToolStartEvent): ProcessedResult<TState> {
    const toolState: ToolState = {
      id: event.toolCallId,
      name: event.toolName,
      state: "pending",
    };

    this.tools.set(event.toolCallId, toolState);

    const block: ToolCallBlock = {
      type: "tool_call",
      id: event.id,
      index: this.blocks.size,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      state: "pending",
    };

    this.blocks.set(event.id, block);

    return {
      toolUpdates: [toolState],
      messageBlocks: [block],
    };
  }

  private processToolInput(event: UIToolInputEvent): ProcessedResult<TState> {
    const existing = this.tools.get(event.toolCallId);
    if (!existing) {
      return {};
    }

    const toolState: ToolState = {
      ...existing,
      input: event.input,
      inputComplete: event.complete,
      state: "running",
    };

    this.tools.set(event.toolCallId, toolState);

    const block = this.findToolBlock(event.toolCallId);
    if (block) {
      const updatedBlock: ToolCallBlock = {
        ...block,
        input: event.input,
        state: "running",
      };
      this.blocks.set(block.id, updatedBlock);
      return {
        toolUpdates: [toolState],
        messageBlocks: [updatedBlock],
      };
    }

    return {
      toolUpdates: [toolState],
    };
  }

  private processToolOutput(event: UIToolOutputEvent): ProcessedResult<TState> {
    const existing = this.tools.get(event.toolCallId);
    if (!existing) {
      return {};
    }

    const toolState: ToolState = {
      ...existing,
      output: event.output,
      state: "complete",
    };

    this.tools.set(event.toolCallId, toolState);

    const block = this.findToolBlock(event.toolCallId);
    if (block) {
      const updatedBlock: ToolCallBlock = {
        ...block,
        output: event.output,
        state: "complete",
      };
      this.blocks.set(block.id, updatedBlock);
      return {
        toolUpdates: [toolState],
        messageBlocks: [updatedBlock],
      };
    }

    return {
      toolUpdates: [toolState],
    };
  }

  private processToolError(event: UIToolErrorEvent): ProcessedResult<TState> {
    const existing = this.tools.get(event.toolCallId);
    if (!existing) {
      return {};
    }

    const toolState: ToolState = {
      ...existing,
      error: event.error,
      state: "error",
    };

    this.tools.set(event.toolCallId, toolState);

    const block = this.findToolBlock(event.toolCallId);
    if (block) {
      const updatedBlock: ToolCallBlock = {
        ...block,
        error: event.error,
        state: "error",
      };
      this.blocks.set(block.id, updatedBlock);
      return {
        toolUpdates: [toolState],
        messageBlocks: [updatedBlock],
      };
    }

    return {
      toolUpdates: [toolState],
    };
  }

  private findToolBlock(toolCallId: string): ToolCallBlock | undefined {
    for (const block of this.blocks.values()) {
      if (block.type === "tool_call" && block.toolCallId === toolCallId) {
        return block;
      }
    }
    return undefined;
  }

  private processBuffered(): ProcessedResult<TState> {
    let result: ProcessedResult<TState> = {};

    while (this.buffer.has(this.expectedSeq)) {
      const event = this.buffer.get(this.expectedSeq)!;
      this.buffer.delete(this.expectedSeq);
      this.expectedSeq++;
      result = this.mergeResults(result, this.processEvent(event));
    }

    return result;
  }

  private mergeResults(
    a: ProcessedResult<TState>,
    b: ProcessedResult<TState>
  ): ProcessedResult<TState> {
    return {
      stateUpdates: { ...a.stateUpdates, ...b.stateUpdates },
      messageBlocks: [...(a.messageBlocks ?? []), ...(b.messageBlocks ?? [])],
      toolUpdates: [...(a.toolUpdates ?? []), ...(b.toolUpdates ?? [])],
      isStateFinal: a.isStateFinal || b.isStateFinal,
    };
  }

  isKeyFinalized(key: keyof TState): boolean {
    return this.finalizedKeys.has(key);
  }

  getCurrentBlocks(): MessageBlock[] {
    return Array.from(this.blocks.values()).sort((a, b) => a.index - b.index);
  }

  getCurrentTools(): ToolState[] {
    return Array.from(this.tools.values());
  }

  getExpectedSeq(): number {
    return this.expectedSeq;
  }

  getBufferSize(): number {
    return this.buffer.size;
  }

  reset(): void {
    this.expectedSeq = 1;
    this.buffer.clear();
    this.finalizedKeys.clear();
    this.blocks.clear();
    this.tools.clear();
  }

  resetForNewStream(streamId: string): void {
    if (streamId !== this.currentStreamId) {
      this.reset();
      this.currentStreamId = streamId;
    }
  }
}
