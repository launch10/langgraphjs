import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useStream } from "./stream.js";
import type {
  UseStreamOptions,
  UseStream,
  BagTemplate,
  SubmitOptions,
} from "./types.js";
import {
  UIEventProcessor,
  type ProcessedResult,
} from "../ui/streaming/processor.js";
import {
  SharedChatRegistry,
  type RegistryOptions,
} from "../ui/streaming/registry.js";
import type {
  MessageWithBlocks,
  StructuredBlock,
  ToolState,
  MergeReducers,
} from "../ui/streaming/types.js";
import { isUIEvent } from "../ui/streaming/types.js";

export interface UseStreamUIOptions<
  TState extends Record<string, unknown>,
  TSchema = unknown,
  Bag extends BagTemplate = BagTemplate,
> extends Omit<UseStreamOptions<TState, Bag>, "onCustomEvent"> {
  schema?: TSchema;
  jsonTarget?: "messages" | "state";
  merge?: MergeReducers<TState>;
  onStateUpdate?: <K extends keyof TState>(key: K, value: TState[K]) => void;
  onStructuredBlock?: (block: StructuredBlock<TSchema>) => void;
  onToolUpdate?: (tool: ToolState) => void;
  onUIError?: (error: Error) => void;
  onCustomEvent?: (
    data: unknown,
    options: {
      namespace: string[] | undefined;
      mutate: (
        update: Partial<TState> | ((prev: TState) => Partial<TState>)
      ) => void;
    }
  ) => void;
}

export interface UISubmitOptions<
  TState extends Record<string, unknown>,
  ConfigurableType extends Record<string, unknown> = Record<string, unknown>,
> extends SubmitOptions<TState, ConfigurableType> {
  optimisticMessage?: string;
}

export interface UseStreamUIResult<
  TState extends Record<string, unknown>,
  TSchema = unknown,
  Bag extends BagTemplate = BagTemplate,
> extends Omit<UseStream<TState, Bag>, "submit"> {
  state: Partial<TState>;
  uiMessages: MessageWithBlocks<TSchema>[];
  tools: ToolState[];
  submit: (
    values: Partial<TState> | null | undefined,
    options?: UISubmitOptions<TState>
  ) => Promise<void>;
  getSubgraphState: (
    namespace: string[]
  ) => Partial<Record<string, unknown>> | undefined;
}

export function useStreamUI<
  TState extends Record<string, unknown>,
  TSchema = unknown,
  Bag extends BagTemplate = BagTemplate,
>(
  options: UseStreamUIOptions<TState, TSchema, Bag>
): UseStreamUIResult<TState, TSchema, Bag> {
  const {
    merge,
    onStateUpdate,
    onStructuredBlock,
    onToolUpdate,
    onUIError,
    onCustomEvent: userOnCustomEvent,
    ...streamOptions
  } = options;

  const registryOptions: RegistryOptions<TState> = useMemo(
    () => ({
      apiUrl: streamOptions.apiUrl ?? "",
      threadId: streamOptions.threadId ?? undefined,
      merge,
    }),
    [streamOptions.apiUrl, streamOptions.threadId, merge]
  );

  const registry = useMemo(
    () => SharedChatRegistry.getOrCreate<TState>(registryOptions),
    [registryOptions]
  );

  useEffect(() => {
    SharedChatRegistry.acquire(registry);
    return () => SharedChatRegistry.release(registry);
  }, [registry]);

  const processorRef = useRef<UIEventProcessor<TState>>(
    new UIEventProcessor({
      onError: onUIError,
    })
  );

  const applyProcessedResult = useCallback(
    (result: ProcessedResult<TState>) => {
      if (result.stateUpdates) {
        for (const [key, value] of Object.entries(result.stateUpdates)) {
          registry.updateState(
            key as keyof TState,
            value as TState[keyof TState]
          );
          onStateUpdate?.(key as keyof TState, value as TState[keyof TState]);
        }
      }

      if (result.messageBlocks?.length) {
        registry.updateMessages(result.messageBlocks);

        for (const block of result.messageBlocks) {
          if (block.type === "structured") {
            onStructuredBlock?.(block as StructuredBlock<TSchema>);
          }
        }
      }

      if (result.toolUpdates?.length) {
        registry.updateTools(result.toolUpdates);
        for (const tool of result.toolUpdates) {
          onToolUpdate?.(tool);
        }
      }
    },
    [registry, onStateUpdate, onStructuredBlock, onToolUpdate]
  );

  const handleCustomEvent = useCallback(
    (
      data: unknown,
      eventOptions: {
        namespace: string[] | undefined;
        mutate: (
          update: Partial<TState> | ((prev: TState) => Partial<TState>)
        ) => void;
      }
    ) => {
      if (isUIEvent(data)) {
        const result = processorRef.current.process(data);
        applyProcessedResult(result);
      }

      userOnCustomEvent?.(data, eventOptions);
    },
    [applyProcessedResult, userOnCustomEvent]
  );

  const streamResult = useStream<TState, Bag>({
    ...streamOptions,
    onCustomEvent: handleCustomEvent,
  } as UseStreamOptions<TState, Bag>);

  const resetForStreamRef = useRef(() => {
    registry.resetForStream();
    processorRef.current.reset();
  });

  useEffect(() => {
    resetForStreamRef.current = () => {
      registry.resetForStream();
      processorRef.current.reset();
    };
  }, [registry]);

  const state = useSyncExternalStore(
    useCallback((cb) => registry.subscribeState(cb), [registry]),
    useCallback(() => registry.getState(), [registry]),
    useCallback(() => registry.getState(), [registry])
  );

  const uiMessages = useSyncExternalStore(
    useCallback((cb) => registry.subscribeMessages(cb), [registry]),
    useCallback(() => registry.getMessages(), [registry]),
    useCallback(() => registry.getMessages(), [registry])
  );

  const tools = useSyncExternalStore(
    useCallback((cb) => registry.subscribeTools(cb), [registry]),
    useCallback(() => registry.getTools(), [registry]),
    useCallback(() => registry.getTools(), [registry])
  );

  const submit = useCallback(
    async (
      values: Partial<TState> | null | undefined,
      submitOptions?: UISubmitOptions<TState>
    ) => {
      if (submitOptions?.optimisticMessage) {
        registry.addUserMessage(submitOptions.optimisticMessage);
      }

      resetForStreamRef.current();

      const { optimisticMessage: _om, ...restOptions } = submitOptions ?? {};
      return streamResult.submit(values, restOptions);
    },
    [streamResult, registry]
  );

  const getSubgraphState = useCallback(
    (namespace: string[]) => registry.getSubgraphState(namespace),
    [registry]
  );

  return {
    ...streamResult,
    state,
    uiMessages,
    tools,
    submit,
    getSubgraphState,
  };
}
