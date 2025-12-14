import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { Client, getClientConfigHash } from "../client.js";
import type { ClientConfig } from "../client.js";
import type { EventStreamEvent } from "../ui/manager.js";
import { getBranchContext } from "../ui/branching.js";
import { unique } from "../ui/utils.js";
import { useControllableThreadId } from "./thread.js";
import {
  UIEventProcessor,
  type ProcessedResult,
} from "../ui/streaming/processor.js";
import { SharedChatRegistry } from "../ui/streaming/registry.js";
import type {
  MessageWithBlocks,
  StructuredBlock,
  ToolState,
  MergeReducers,
} from "../ui/streaming/types.js";
import { isUIEvent } from "../ui/streaming/types.js";
import type { Message } from "../types.messages.js";
import type { ThreadState, Interrupt, Checkpoint, Metadata, Config } from "../schema.js";
import type { StreamMode } from "../types.stream.js";
import type { Command, MultitaskStrategy, OnCompletionBehavior, DisconnectMode, Durability } from "../types.js";
import type { Sequence } from "../ui/branching.js";
import { useSmartSubscription } from "./use-smart-subscription.js";

export interface UseStreamUIOptions<
  TState extends Record<string, unknown>,
  TSchema = unknown,
> {
  assistantId: string;
  client?: Client;
  apiUrl?: ClientConfig["apiUrl"];
  apiKey?: ClientConfig["apiKey"];
  callerOptions?: ClientConfig["callerOptions"];
  defaultHeaders?: ClientConfig["defaultHeaders"];
  messagesKey?: string;
  threadId?: string | null;
  onThreadId?: (threadId: string) => void;
  initialValues?: TState | null;
  fetchStateHistory?: boolean | { limit: number };
  throttle?: number | boolean;
  schema?: TSchema;
  jsonTarget?: "messages" | "state";
  merge?: MergeReducers<TState>;
  onStateUpdate?: <K extends keyof TState>(key: K, value: TState[K]) => void;
  onStructuredBlock?: (block: StructuredBlock<TSchema>) => void;
  onToolUpdate?: (tool: ToolState) => void;
  onUIError?: (error: Error) => void;
  onError?: (error: unknown) => void;
  onFinish?: (state: ThreadState<TState>) => void;
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
> {
  config?: Config & { configurable?: ConfigurableType };
  context?: ConfigurableType;
  checkpoint?: Omit<Checkpoint, "thread_id"> | null;
  command?: Command;
  interruptBefore?: "*" | string[];
  interruptAfter?: "*" | string[];
  metadata?: Metadata;
  multitaskStrategy?: MultitaskStrategy;
  onCompletion?: OnCompletionBehavior;
  onDisconnect?: DisconnectMode;
  streamMode?: Array<StreamMode>;
  streamSubgraphs?: boolean;
  streamResumable?: boolean;
  durability?: Durability;
  threadId?: string;
  optimisticValues?: Partial<TState> | ((prev: TState) => Partial<TState>);
  optimisticMessage?: string;
}

export interface UISnapshot<
  TState extends Record<string, unknown>,
  TSchema = unknown,
> {
  values: TState;
  error: unknown;
  isLoading: boolean;
  isThreadLoading: boolean;
  branch: string;
  history: ThreadState<TState>[];
  experimental_branchTree: Sequence<TState>;
  interrupt: Interrupt | undefined;
  messages: Message[];
  state: Partial<TState>;
  uiMessages: MessageWithBlocks<TSchema>[];
  tools: ToolState[];
  submit: (
    values: Partial<TState> | null | undefined,
    options?: UISubmitOptions<TState>
  ) => Promise<void>;
  stop: () => Promise<void>;
  setBranch: (branch: string) => void;
  getSubgraphState: (
    namespace: string[]
  ) => Partial<Record<string, unknown>> | undefined;
  client: Client;
  assistantId: string;
}

export interface UseStreamUIResult<
  TState extends Record<string, unknown>,
  TSchema = unknown,
> {
  values: TState;
  error: unknown;
  isLoading: boolean;
  isThreadLoading: boolean;
  branch: string;
  history: ThreadState<TState>[];
  experimental_branchTree: Sequence<TState>;
  interrupt: Interrupt | undefined;
  messages: Message[];
  state: Partial<TState>;
  uiMessages: MessageWithBlocks<TSchema>[];
  tools: ToolState[];
  submit: (
    values: Partial<TState> | null | undefined,
    options?: UISubmitOptions<TState>
  ) => Promise<void>;
  stop: () => Promise<void>;
  setBranch: (branch: string) => void;
  getSubgraphState: (
    namespace: string[]
  ) => Partial<Record<string, unknown>> | undefined;
  client: Client;
  assistantId: string;
}

function getFetchHistoryKey(
  client: Client,
  threadId: string | undefined | null,
  limit: boolean | number
) {
  return [getClientConfigHash(client), threadId, limit].join(":");
}

function fetchHistory<StateType extends Record<string, unknown>>(
  client: Client,
  threadId: string,
  options?: { limit?: boolean | number }
) {
  if (options?.limit === false) {
    return client.threads.getState<StateType>(threadId).then((state) => {
      if (state.checkpoint == null) return [];
      return [state];
    });
  }

  const limit = typeof options?.limit === "number" ? options.limit : 10;
  return client.threads.getHistory<StateType>(threadId, { limit });
}

export function useStreamUI<
  TState extends Record<string, unknown>,
  TSchema = unknown,
>(
  options: UseStreamUIOptions<TState, TSchema>
): UseStreamUIResult<TState, TSchema>;

export function useStreamUI<
  TState extends Record<string, unknown>,
  TSchema = unknown,
  TSelected = unknown,
>(
  options: UseStreamUIOptions<TState, TSchema>,
  selector: (snapshot: UISnapshot<TState, TSchema>) => TSelected
): TSelected;

export function useStreamUI<
  TState extends Record<string, unknown>,
  TSchema = unknown,
  TSelected = unknown,
>(
  options: UseStreamUIOptions<TState, TSchema>,
  selector?: (snapshot: UISnapshot<TState, TSchema>) => TSelected
): UseStreamUIResult<TState, TSchema> | TSelected {
  const {
    merge,
    onStateUpdate,
    onStructuredBlock,
    onToolUpdate,
    onUIError,
    onCustomEvent: userOnCustomEvent,
    onError,
    onFinish,
  } = options;

  const client = useMemo(
    () =>
      options.client ??
      new Client({
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        callerOptions: options.callerOptions,
        defaultHeaders: options.defaultHeaders,
      }),
    [
      options.client,
      options.apiKey,
      options.apiUrl,
      options.callerOptions,
      options.defaultHeaders,
    ]
  );

  const [threadId, onThreadIdChange] = useControllableThreadId(options);

  const registry = useMemo(
    () =>
      SharedChatRegistry.getOrCreate<TState>({
        apiUrl: options.apiUrl ?? "",
        threadId: threadId ?? undefined,
        merge,
        throttle: options.throttle ?? false,
      }),
    [merge, options.apiUrl, options.throttle, threadId]
  );

  useEffect(() => {
    SharedChatRegistry.acquire(registry);
    return () => SharedChatRegistry.release(registry);
  }, [registry]);

  const branchRef = useRef<string>("");
  const setBranch = useCallback((newBranch: string) => {
    branchRef.current = newBranch;
    registry.notifyAllSubscribers();
  }, [registry]);

  const stream = useMemo(() => registry.getOrCreateStreamManager(), [registry]);

  const threadIdRef = useRef<string | null>(threadId);
  const threadIdStreamingRef = useRef<string | null>(null);

  useEffect(() => {
    if (threadIdRef.current !== threadId) {
      threadIdRef.current = threadId;
      stream.clear();
      registry.clear();
    }
  }, [threadId, stream, registry]);

  const historyLimit =
    typeof options.fetchStateHistory === "object" &&
    options.fetchStateHistory != null
      ? options.fetchStateHistory.limit ?? false
      : options.fetchStateHistory ?? false;

  const historyKey = getFetchHistoryKey(client, threadId, historyLimit);

  const clientRef = useRef(client);
  clientRef.current = client;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const fetchHistoryData = useCallback(
    (fetchThreadId: string | undefined | null, limit: boolean | number) => {
      const currentClient = clientRef.current;

      if (fetchThreadId != null) {
        registry.setIsHistoryLoading(true);
        return fetchHistory<TState>(currentClient, fetchThreadId, { limit }).then(
          (data) => {
            registry.setHistory(data);
            registry.setIsHistoryLoading(false);
            return data;
          },
          (fetchError) => {
            registry.setError(fetchError);
            registry.setIsHistoryLoading(false);
            onErrorRef.current?.(fetchError);
            return Promise.reject(fetchError);
          }
        );
      }

      registry.setHistory([]);
      registry.setIsHistoryLoading(false);
      return Promise.resolve([]);
    },
    [registry]
  );

  useEffect(() => {
    if (
      threadIdStreamingRef.current != null &&
      threadIdStreamingRef.current === threadId
    ) {
      return;
    }
    void fetchHistoryData(threadId, historyLimit);
  }, [fetchHistoryData, historyKey, threadId, historyLimit]);

  const processorRef = useRef<UIEventProcessor<TState>>(
    new UIEventProcessor({ onError: onUIError })
  );

  const applyProcessedResult = useCallback(
    (result: ProcessedResult<TState>) => {
      if (result.stateUpdates) {
        for (const [key, value] of Object.entries(result.stateUpdates)) {
          registry.updateState(key as keyof TState, value as TState[keyof TState]);
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

  const processCustomEvent = useCallback(
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

  const getMessages = useCallback(
    (value: TState): Message[] => {
      const messagesKey = options.messagesKey ?? "messages";
      return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
    },
    [options.messagesKey]
  );

  const setMessages = useCallback(
    (current: TState, messages: Message[]): TState => {
      const messagesKey = options.messagesKey ?? "messages";
      return { ...current, [messagesKey]: messages };
    },
    [options.messagesKey]
  );

  const history = registry.getHistory();
  const branch = branchRef.current;
  const branchContext = getBranchContext(branch, history.length > 0 ? history : undefined);

  const historyValues = useMemo(
    () =>
      branchContext.threadHead?.values ??
      options.initialValues ??
      ({} as TState),
    [branchContext.threadHead?.values, options.initialValues]
  );

  const stop = useCallback(async () => {
    await stream.stop(historyValues, {});
  }, [stream, historyValues]);

  const submit = useCallback(
    async (
      values: Partial<TState> | null | undefined,
      submitOptions?: UISubmitOptions<TState>
    ) => {
      const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
      setBranch(
        checkpointId != null
          ? branchContext.branchByCheckpoint[checkpointId]?.branch ?? ""
          : ""
      );

      if (submitOptions?.optimisticMessage) {
        registry.addUserMessage(submitOptions.optimisticMessage);
      }

      registry.resetForStream();
      processorRef.current.reset();

      const initialStreamValues = (() => {
        const prev = { ...historyValues, ...stream.values };

        if (submitOptions?.optimisticValues != null) {
          return {
            ...prev,
            ...(typeof submitOptions.optimisticValues === "function"
              ? submitOptions.optimisticValues(prev)
              : submitOptions.optimisticValues),
          };
        }

        return { ...prev };
      })();

      stream.setStreamValues(() => initialStreamValues);
      registry.setStreamValues(initialStreamValues);

      let usableThreadId = threadId;

      await stream.start(
        async (signal: AbortSignal) => {
          if (!usableThreadId) {
            const thread = await client.threads.create({
              threadId: submitOptions?.threadId,
              metadata: submitOptions?.metadata,
              signal,
            });

            usableThreadId = thread.thread_id;
            threadIdRef.current = usableThreadId;
            threadIdStreamingRef.current = usableThreadId;
            onThreadIdChange(usableThreadId);
          }

          if (!usableThreadId) {
            throw new Error("Failed to obtain valid thread ID.");
          }

          threadIdStreamingRef.current = usableThreadId;
          registry.setIsLoading(true);

          const streamMode = unique([
            ...(submitOptions?.streamMode ?? []),
            "messages-tuple" as const,
            "values" as const,
            "custom" as const,
            "ui" as const,
          ]);

          let checkpoint =
            submitOptions?.checkpoint ??
            (historyLimit === true || typeof historyLimit === "number"
              ? branchContext.threadHead?.checkpoint
              : undefined) ??
            undefined;

          if (submitOptions?.checkpoint === null) checkpoint = undefined;
          if (checkpoint != null) delete (checkpoint as Record<string, unknown>).thread_id;

          return client.runs.stream(usableThreadId, options.assistantId, {
            input: values as Record<string, unknown>,
            config: submitOptions?.config,
            context: submitOptions?.context,
            command: submitOptions?.command,
            interruptBefore: submitOptions?.interruptBefore,
            interruptAfter: submitOptions?.interruptAfter,
            metadata: submitOptions?.metadata,
            multitaskStrategy: submitOptions?.multitaskStrategy,
            onCompletion: submitOptions?.onCompletion,
            onDisconnect: submitOptions?.onDisconnect ?? "cancel",
            signal,
            checkpoint,
            streamMode,
            streamSubgraphs: submitOptions?.streamSubgraphs,
            streamResumable: submitOptions?.streamResumable,
            durability: submitOptions?.durability,
          }) as AsyncGenerator<EventStreamEvent<TState, Partial<TState>, unknown>>;
        },
        {
          getMessages,
          setMessages,
          initialValues: historyValues,
          callbacks: {
            onCustomEvent: processCustomEvent,
          },
          async onSuccess() {
            if (onFinish || historyLimit) {
              const newHistory = await fetchHistoryData(usableThreadId!, historyLimit);
              const lastHead = newHistory?.at(0);
              if (lastHead && onFinish) {
                onFinish(lastHead);
              }
              return null;
            }
            return undefined;
          },
          onError(streamError) {
            registry.setError(streamError);
            onError?.(streamError);
          },
          onFinish() {
            threadIdStreamingRef.current = null;
            registry.setIsLoading(false);
          },
        }
      );
    },
    [
      client,
      options.assistantId,
      threadId,
      onThreadIdChange,
      historyValues,
      historyLimit,
      branchContext,
      stream,
      registry,
      getMessages,
      setMessages,
      processCustomEvent,
      onError,
      onFinish,
      fetchHistoryData,
      setBranch,
    ]
  );

  useEffect(() => {
    const unsubscribe = stream.subscribe(() => {
      registry.setStreamValues(stream.values);
      registry.setIsLoading(stream.isLoading);
      if (stream.error) {
        registry.setError(stream.error);
      }
    });
    return unsubscribe;
  }, [stream, registry]);

  const getSubgraphState = useCallback(
    (namespace: string[]) => registry.getSubgraphState(namespace),
    [registry]
  );

  const getSnapshot = useCallback(
    (): UISnapshot<TState, TSchema> => {
      const values = registry.getValues();
      const error = registry.getError();
      const isLoading = registry.getIsLoading();
      const isHistoryLoading = registry.getIsHistoryLoading();
      const state = registry.getState();
      const uiMessages = registry.getMessages() as MessageWithBlocks<TSchema>[];
      const tools = registry.getTools();
      const currentBranch = branchRef.current;
      const currentHistory = registry.getHistory();
      const currentBranchContext = getBranchContext(currentBranch, currentHistory.length > 0 ? currentHistory : undefined);

      const snapshot: UISnapshot<TState, TSchema> = {
        values,
        error,
        isLoading,
        isThreadLoading: isHistoryLoading,
        branch: currentBranch,
        history: currentBranchContext.flatHistory,
        experimental_branchTree: currentBranchContext.branchTree,
        interrupt: (() => {
          if (
            values != null &&
            "__interrupt__" in values &&
            Array.isArray(values.__interrupt__)
          ) {
            const valueInterrupts = values.__interrupt__;
            if (valueInterrupts.length === 0) return { when: "breakpoint" } as Interrupt;
            if (valueInterrupts.length === 1) return valueInterrupts[0] as Interrupt;
            return valueInterrupts as unknown as Interrupt;
          }

          if (isLoading) return undefined;

          const interrupts = currentBranchContext.threadHead?.tasks?.at(-1)?.interrupts;
          if (interrupts == null || interrupts.length === 0) {
            const next = currentBranchContext.threadHead?.next ?? [];
            if (!next.length || error != null) return undefined;
            return { when: "breakpoint" } as Interrupt;
          }

          return interrupts.at(-1) as Interrupt | undefined;
        })(),
        messages: getMessages(values),
        state,
        uiMessages,
        tools,
        submit,
        stop,
        setBranch,
        getSubgraphState,
        client,
        assistantId: options.assistantId,
      };

      return snapshot;
    },
    [registry, getMessages, submit, stop, setBranch, getSubgraphState, client, options.assistantId]
  );

  const result = useSmartSubscription(
    registry,
    selector as ((snapshot: UISnapshot<TState, TSchema>) => TSelected) | undefined,
    getSnapshot
  );

  return result as UseStreamUIResult<TState, TSchema> | TSelected;
}

export function useStreamUIState<
  TState extends Record<string, unknown>,
  TSchema = unknown,
  K extends keyof TState = keyof TState,
>(
  options: UseStreamUIOptions<TState, TSchema>,
  key: K
): TState[K] | undefined {
  return useStreamUI(options, (s) => s.state[key]) as TState[K] | undefined;
}

export function useStreamUIMessages<
  TState extends Record<string, unknown>,
  TSchema = unknown,
>(
  options: UseStreamUIOptions<TState, TSchema>
): MessageWithBlocks<TSchema>[] {
  return useStreamUI(options, (s) => s.uiMessages);
}

export function useStreamUITools<
  TState extends Record<string, unknown>,
  TSchema = unknown,
>(options: UseStreamUIOptions<TState, TSchema>): ToolState[] {
  return useStreamUI(options, (s) => s.tools);
}

export function useStreamUIActions<
  TState extends Record<string, unknown>,
  TSchema = unknown,
>(options: UseStreamUIOptions<TState, TSchema>) {
  return useStreamUI(options, (s) => ({
    submit: s.submit,
    stop: s.stop,
    setBranch: s.setBranch,
  }));
}
