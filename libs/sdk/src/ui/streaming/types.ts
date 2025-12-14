export interface UIEventBase {
  type: string;
  id: string;
  seq: number;
  timestamp: number;
  namespace?: string[];
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

export interface UIContentReasoningEvent extends UIEventBase {
  type: "ui:content:reasoning";
  messageId: string;
  blockId: string;
  index: number;
  text: string;
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

export interface UIToolStartEvent extends UIEventBase {
  type: "ui:tool:start";
  toolCallId: string;
  toolName: string;
}

export interface UIToolInputEvent extends UIEventBase {
  type: "ui:tool:input";
  toolCallId: string;
  input: unknown;
  complete: boolean;
}

export interface UIToolOutputEvent extends UIEventBase {
  type: "ui:tool:output";
  toolCallId: string;
  output: unknown;
}

export interface UIToolErrorEvent extends UIEventBase {
  type: "ui:tool:error";
  toolCallId: string;
  error: string;
  retryable: boolean;
}

export type UIEvent =
  | UIContentTextEvent
  | UIContentStructuredEvent
  | UIContentReasoningEvent
  | UIStateStreamingEvent
  | UIStateFinalEvent
  | UIToolStartEvent
  | UIToolInputEvent
  | UIToolOutputEvent
  | UIToolErrorEvent;

export interface TextBlock {
  type: "text";
  id: string;
  index: number;
  text: string;
}

export interface StructuredBlock<TSchema = unknown> {
  type: "structured";
  id: string;
  index: number;
  data: TSchema;
  sourceText: string;
  partial: boolean;
}

export interface ReasoningBlock {
  type: "reasoning";
  id: string;
  index: number;
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  index: number;
  toolCallId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  state: ToolCallState;
}

export type ToolCallState = "pending" | "running" | "complete" | "error";

export type MessageBlock<TSchema = unknown> =
  | TextBlock
  | StructuredBlock<TSchema>
  | ReasoningBlock
  | ToolCallBlock;

export interface MessageWithBlocks<TSchema = unknown> {
  id: string;
  role: "user" | "assistant";
  blocks: MessageBlock<TSchema>[];
  raw?: unknown;
}

export interface ToolState {
  id: string;
  name: string;
  state: ToolCallState;
  input?: unknown;
  inputComplete?: boolean;
  output?: unknown;
  error?: string;
}

export type MergeReducer<T> = (incoming: T, current: T | undefined) => T;

export type MergeReducers<TState> = {
  [K in keyof TState]?: MergeReducer<TState[K]>;
};

export interface ParsedBlock {
  type: "text" | "structured" | "reasoning";
  id: string;
  index: number;
  text?: string;
  data?: unknown;
  sourceText?: string;
}

export function isUIEvent(event: unknown): event is UIEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    typeof (event as { type: unknown }).type === "string" &&
    (event as { type: string }).type.startsWith("ui:")
  );
}

export function isUIContentTextEvent(
  event: unknown
): event is UIContentTextEvent {
  return isUIEvent(event) && event.type === "ui:content:text";
}

export function isUIContentStructuredEvent(
  event: unknown
): event is UIContentStructuredEvent {
  return isUIEvent(event) && event.type === "ui:content:structured";
}

export function isUIContentReasoningEvent(
  event: unknown
): event is UIContentReasoningEvent {
  return isUIEvent(event) && event.type === "ui:content:reasoning";
}

export function isUIStateStreamingEvent(
  event: unknown
): event is UIStateStreamingEvent {
  return isUIEvent(event) && event.type === "ui:state:streaming";
}

export function isUIStateFinalEvent(
  event: unknown
): event is UIStateFinalEvent {
  return isUIEvent(event) && event.type === "ui:state:final";
}

export function isUIToolStartEvent(event: unknown): event is UIToolStartEvent {
  return isUIEvent(event) && event.type === "ui:tool:start";
}

export function isUIToolInputEvent(event: unknown): event is UIToolInputEvent {
  return isUIEvent(event) && event.type === "ui:tool:input";
}

export function isUIToolOutputEvent(
  event: unknown
): event is UIToolOutputEvent {
  return isUIEvent(event) && event.type === "ui:tool:output";
}

export function isUIToolErrorEvent(event: unknown): event is UIToolErrorEvent {
  return isUIEvent(event) && event.type === "ui:tool:error";
}

export function createUIEventId(): string {
  return crypto.randomUUID();
}

let sequenceCounter = 0;

export function nextSequence(): number {
  sequenceCounter += 1;
  return sequenceCounter;
}

export function resetSequence(): void {
  sequenceCounter = 0;
}
