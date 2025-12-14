import type {
  MessageWithBlocks,
  MessageBlock,
  ToolState,
  MergeReducers,
  TextBlock,
} from "./types.js";

export interface RegistryOptions<TState extends Record<string, unknown>> {
  apiUrl: string;
  threadId?: string;
  merge?: MergeReducers<TState>;
}

const registries = new Map<string, SharedChatRegistry<Record<string, unknown>>>();
const refCounts = new Map<string, number>();

export class SharedChatRegistry<TState extends Record<string, unknown>> {
  private key: string;
  private state: Partial<TState> = {};
  private preStreamState: Partial<TState> = {};
  private messages: MessageWithBlocks[] = [];
  private tools: ToolState[] = [];
  private subgraphState: Map<string, Partial<Record<string, unknown>>> =
    new Map();
  private mergeReducers: MergeReducers<TState>;

  private stateSubscribers: Set<() => void> = new Set();
  private messageSubscribers: Set<() => void> = new Set();
  private toolSubscribers: Set<() => void> = new Set();

  static getKey(apiUrl: string, threadId?: string): string {
    return `${apiUrl}::${threadId ?? "default"}`;
  }

  static getOrCreate<TState extends Record<string, unknown>>(
    options: RegistryOptions<TState>
  ): SharedChatRegistry<TState> {
    const key = SharedChatRegistry.getKey(options.apiUrl, options.threadId);

    if (!registries.has(key)) {
      const registry = new SharedChatRegistry<TState>(
        key,
        options.merge ?? ({} as MergeReducers<TState>)
      );
      registries.set(key, registry as SharedChatRegistry<Record<string, unknown>>);
      refCounts.set(key, 0);
    }

    return registries.get(key) as SharedChatRegistry<TState>;
  }

  static acquire<TState extends Record<string, unknown>>(
    registry: SharedChatRegistry<TState>
  ): void {
    const count = refCounts.get(registry.key) ?? 0;
    refCounts.set(registry.key, count + 1);
  }

  static release<TState extends Record<string, unknown>>(
    registry: SharedChatRegistry<TState>
  ): void {
    const count = refCounts.get(registry.key) ?? 0;
    const newCount = Math.max(0, count - 1);
    refCounts.set(registry.key, newCount);

    if (newCount === 0) {
      registries.delete(registry.key);
      refCounts.delete(registry.key);
    }
  }

  static getRefCount<TState extends Record<string, unknown>>(
    registry: SharedChatRegistry<TState>
  ): number {
    return refCounts.get(registry.key) ?? 0;
  }

  static clearAll(): void {
    registries.clear();
    refCounts.clear();
  }

  private constructor(key: string, mergeReducers: MergeReducers<TState>) {
    this.key = key;
    this.mergeReducers = mergeReducers;
  }

  getState(): Partial<TState> {
    return { ...this.state };
  }

  updateState<K extends keyof TState>(
    key: K,
    value: TState[K],
    namespace?: string[]
  ): void {
    if (namespace && namespace.length > 0) {
      this.updateSubgraphState(namespace, key as string, value);
      return;
    }

    const reducer = this.mergeReducers[key];
    const baseValue = this.preStreamState[key];

    if (reducer) {
      this.state[key] = reducer(value, baseValue);
    } else {
      this.state[key] = value;
    }

    this.notifyStateSubscribers();
  }

  private updateSubgraphState(
    namespace: string[],
    key: string,
    value: unknown
  ): void {
    const nsKey = namespace.join("|");
    const current = this.subgraphState.get(nsKey) ?? {};
    this.subgraphState.set(nsKey, { ...current, [key]: value });
    this.notifyStateSubscribers();
  }

  getSubgraphState(
    namespace: string[]
  ): Partial<Record<string, unknown>> | undefined {
    return this.subgraphState.get(namespace.join("|"));
  }

  getMessages(): MessageWithBlocks[] {
    return [...this.messages];
  }

  updateMessages(blocks: MessageBlock[]): void {
    if (blocks.length === 0) return;

    let currentMessage = this.messages[this.messages.length - 1];

    if (!currentMessage || currentMessage.role !== "assistant") {
      currentMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [],
      };
      this.messages = [...this.messages, currentMessage];
    }

    const blockMap = new Map(currentMessage.blocks.map((b) => [b.id, b]));
    for (const block of blocks) {
      blockMap.set(block.id, block);
    }

    currentMessage = {
      ...currentMessage,
      blocks: Array.from(blockMap.values()).sort((a, b) => a.index - b.index),
    };

    this.messages = [...this.messages.slice(0, -1), currentMessage];
    this.notifyMessageSubscribers();
  }

  addUserMessage(content: string): void {
    const textBlock: TextBlock = {
      type: "text",
      id: crypto.randomUUID(),
      index: 0,
      text: content,
    };

    const message: MessageWithBlocks = {
      id: crypto.randomUUID(),
      role: "user",
      blocks: [textBlock],
    };
    this.messages = [...this.messages, message];
    this.notifyMessageSubscribers();
  }

  getTools(): ToolState[] {
    return [...this.tools];
  }

  updateTools(tools: ToolState[]): void {
    if (tools.length === 0) return;

    const toolMap = new Map(this.tools.map((t) => [t.id, t]));
    for (const tool of tools) {
      toolMap.set(tool.id, tool);
    }
    this.tools = Array.from(toolMap.values());
    this.notifyToolSubscribers();
  }

  subscribeState(callback: () => void): () => void {
    this.stateSubscribers.add(callback);
    return () => this.stateSubscribers.delete(callback);
  }

  subscribeMessages(callback: () => void): () => void {
    this.messageSubscribers.add(callback);
    return () => this.messageSubscribers.delete(callback);
  }

  subscribeTools(callback: () => void): () => void {
    this.toolSubscribers.add(callback);
    return () => this.toolSubscribers.delete(callback);
  }

  private notifyStateSubscribers(): void {
    this.stateSubscribers.forEach((cb) => cb());
  }

  private notifyMessageSubscribers(): void {
    this.messageSubscribers.forEach((cb) => cb());
  }

  private notifyToolSubscribers(): void {
    this.toolSubscribers.forEach((cb) => cb());
  }

  resetForStream(): void {
    this.preStreamState = { ...this.state };
    this.tools = [];
    this.subgraphState.clear();
  }

  loadFromHistory(
    messages: MessageWithBlocks[],
    state: Partial<TState>
  ): void {
    this.messages = messages;
    this.state = { ...state };
    this.preStreamState = { ...state };
    this.notifyMessageSubscribers();
    this.notifyStateSubscribers();
  }

  getKey(): string {
    return this.key;
  }
}
