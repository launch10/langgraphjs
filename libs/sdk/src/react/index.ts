export { useStream } from "./stream.js";
export { FetchStreamTransport } from "./stream.custom.js";
export {
  useStreamUI,
  type UseStreamUIOptions,
  type UseStreamUIResult,
  type UISubmitOptions,
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
export {
  useSubgraphState,
  type UseSubgraphStateOptions,
} from "./use-subgraph-state.js";
export type {
  MessageMetadata,
  UseStream,
  UseStreamOptions,
  UseStreamCustom,
  UseStreamCustomOptions,
  UseStreamTransport,
  UseStreamThread,
} from "./types.js";

export { MergeStrategies } from "../ui/streaming/merge.js";
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
