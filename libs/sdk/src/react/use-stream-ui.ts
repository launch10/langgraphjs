import { useCallback, useEffect, useRef, useMemo, useReducer } from "react";
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

function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    ) {
      return false;
    }
  }
  return true;
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

  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const mergeRef = useRef(merge);
  mergeRef.current = merge;

  const registryKey = `${streamOptions.apiUrl ?? ""}:${streamOptions.threadId ?? ""}`;

  const registry = useMemo(
    () =>
      SharedChatRegistry.getOrCreate<TState>({
        apiUrl: streamOptions.apiUrl ?? "",
        threadId: streamOptions.threadId ?? undefined,
        merge: mergeRef.current,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registryKey]
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

  const lastStateRef = useRef<Partial<TState>>({});
  const lastMessagesRef = useRef<MessageWithBlocks<TSchema>[]>([]);
  const lastToolsRef = useRef<ToolState[]>([]);

  const checkForUpdates = useCallback(() => {
    const newState = registry.getState();
    const newMessages = registry.getMessages() as MessageWithBlocks<TSchema>[];
    const newTools = registry.getTools();

    const stateChanged = !shallowEqual(lastStateRef.current, newState);
    const messagesChanged = !shallowEqual(lastMessagesRef.current, newMessages);
    const toolsChanged = !shallowEqual(lastToolsRef.current, newTools);

    if (stateChanged || messagesChanged || toolsChanged) {
      lastStateRef.current = newState;
      lastMessagesRef.current = newMessages;
      lastToolsRef.current = newTools;
      forceRender();
    }
  }, [registry]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    unsubs.push(registry.subscribeState(checkForUpdates));
    unsubs.push(registry.subscribeMessages(checkForUpdates));
    unsubs.push(registry.subscribeTools(checkForUpdates));
    return () => unsubs.forEach((fn) => fn());
  }, [registry, checkForUpdates]);

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

  lastStateRef.current = registry.getState();
  lastMessagesRef.current =
    registry.getMessages() as MessageWithBlocks<TSchema>[];
  lastToolsRef.current = registry.getTools();

  const result = {
    get values() {
      return streamResult.values;
    },
    get error() {
      return streamResult.error;
    },
    get isLoading() {
      return streamResult.isLoading;
    },
    get isThreadLoading() {
      return streamResult.isThreadLoading;
    },
    stop: streamResult.stop,
    get branch() {
      return streamResult.branch;
    },
    setBranch: streamResult.setBranch,
    get history() {
      return streamResult.history;
    },
    get experimental_branchTree() {
      return streamResult.experimental_branchTree;
    },
    get interrupt() {
      return streamResult.interrupt;
    },
    get messages() {
      return streamResult.messages;
    },
    getMessagesMetadata: streamResult.getMessagesMetadata,
    client: streamResult.client,
    assistantId: streamResult.assistantId,
    joinStream: streamResult.joinStream,
    state: lastStateRef.current,
    uiMessages: lastMessagesRef.current,
    tools: lastToolsRef.current,
    submit,
    getSubgraphState,
  };

  return result as UseStreamUIResult<TState, TSchema, Bag>;
}
