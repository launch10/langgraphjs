import { AIMessage, AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import {
  toStructuredMessage,
  type ToStructuredMessageResult,
  type StateTransforms,
} from "./to-structured-message.mjs";
import type { JSONBlockBelongsTo } from "./text-block-parser.mjs";

export interface BridgeConfig<TState extends Record<string, unknown>> {
  jsonTarget: JSONBlockBelongsTo;
  transforms?: StateTransforms<TState>;
}

export interface Bridge<TState extends Record<string, unknown>> {
  jsonTarget: JSONBlockBelongsTo;
  transforms?: StateTransforms<TState>;
  toStructuredMessage: (
    message: BaseMessage | AIMessage | AIMessageChunk
  ) => Promise<ToStructuredMessageResult<TState | undefined>>;
  applyTransforms: (raw: Record<string, unknown>) => TState;
}

export function createBridge<TState extends Record<string, unknown>>(
  config: BridgeConfig<TState>
): Bridge<TState> {
  const { jsonTarget, transforms } = config;

  const applyTransforms = (raw: Record<string, unknown>): TState => {
    if (!transforms) return raw as TState;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      const transform = transforms[key as keyof TState] as
        | ((raw: unknown) => unknown)
        | undefined;
      result[key] = transform ? transform(value) : value;
    }
    return result as TState;
  };

  const bridgeToStructuredMessage = async (
    message: BaseMessage | AIMessage | AIMessageChunk
  ): Promise<ToStructuredMessageResult<TState | undefined>> => {
    if (jsonTarget === "messages") {
      return toStructuredMessage(message, "messages") as Promise<
        ToStructuredMessageResult<TState | undefined>
      >;
    }
    return toStructuredMessage<TState>(message, "state", transforms);
  };

  return {
    jsonTarget,
    transforms,
    toStructuredMessage: bridgeToStructuredMessage,
    applyTransforms,
  };
}
