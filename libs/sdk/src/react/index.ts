export { useStream } from "./stream.js";
export { FetchStreamTransport } from "./stream.custom.js";
export {
  useStreamUI,
  useStreamUIState as useStreamUIStateSelector,
  useStreamUIMessages as useStreamUIMessagesSelector,
  useStreamUITools as useStreamUIToolsSelector,
  useStreamUIActions,
  type UseStreamUIOptions,
  type UseStreamUIResult,
  type UISubmitOptions,
  type UISnapshot,
  type RunMetadataStorage,
} from "./use-stream-ui.js";
export {
  useStreamUIState,
  type UseStreamUIStateOptions,
} from "./use-stream-ui-state.js";
export {
  useStreamUIMessages,
  type UseStreamUIMessagesOptions,
} from "./use-stream-ui-messages.js";
export {
  useStreamUITools,
  type UseStreamUIToolsOptions,
} from "./use-stream-ui-tools.js";
export { useSmartSubscription } from "./use-smart-subscription.js";
export {
  detectAccess,
  createEmptyAccessMap,
  createTrackingProxy,
  type AccessMap,
} from "./access-detector.js";
export {
  useSubgraphState,
  type UseSubgraphStateOptions,
} from "./use-subgraph-state.js";
export type {
  MessageMetadata,
  UseStreamOptions,
  UseStreamCustomOptions,
  UseStreamTransport,
  UseStreamThread,
} from "./types.js";
export type {
  GetToolCallsType,
  // Agent type extraction helpers
  AgentTypeConfigLike,
  IsAgentLike,
  ExtractAgentConfig,
  InferAgentToolCalls,
} from "../ui/types.js";
export type {
  ToolCallWithResult,
  ToolCallState,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "../types.messages.js";

export { MergeStrategies, stableHash, createStableId, createPrefixedStableId } from "../ui/streaming/merge.js";
export type {
  MessageWithBlocks,
  MessageBlock,
  TextBlock,
  StructuredBlock,
  ReasoningBlock,
  ToolCallBlock,
  ToolState,
  MergeReducer,
  MergeReducers,
} from "../ui/streaming/types.js";
