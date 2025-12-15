# useStreamUI React Hook

`useStreamUI` is a production-ready React hook for building rich streaming chat interfaces with LangGraph backends. It provides fine-grained subscriptions, automatic reconnection, optimistic updates, and structured content parsing.

## Installation

```bash
npm install @langchain/langgraph-sdk react
```

## Quick Start

```tsx
import { useStreamUI } from "@langchain/langgraph-sdk/react";

function Chat() {
  const {
    uiMessages,
    state,
    isLoading,
    submit,
    stop,
  } = useStreamUI({
    apiUrl: "http://localhost:8080/api",
    assistantId: "my-agent",
  });

  const handleSubmit = (message: string) => {
    submit(
      { messages: [{ role: "user", content: message }] },
      { optimisticMessage: message }
    );
  };

  return (
    <div>
      {uiMessages.map((msg) => (
        <Message key={msg.id} message={msg} />
      ))}
      {isLoading && <LoadingIndicator />}
      <MessageInput onSubmit={handleSubmit} disabled={isLoading} />
      {isLoading && <button onClick={stop}>Stop</button>}
    </div>
  );
}
```

## Configuration Reference

### `UseStreamUIOptions<TState, TSchema>`

```typescript
interface UseStreamUIOptions<TState, TSchema> {
  // Required
  assistantId: string;                  // The assistant/graph ID to use

  // Client Configuration
  apiUrl?: string;                      // API URL (default: from client or env)
  apiKey?: string;                      // API key for authentication
  client?: Client;                      // Pre-configured LangGraph client
  defaultHeaders?: Record<string, string>; // Headers to include in all requests
  callerOptions?: {                     // Fetch options
    signal?: AbortSignal;
    headers?: Record<string, string>;
  };

  // Thread Management
  threadId?: string | null;             // Explicit thread ID to use
  getInitialThreadId?: () => string | undefined; // Function to get initial thread ID
  onThreadId?: (threadId: string) => void; // Callback when thread ID changes

  // State Configuration
  initialValues?: TState | null;        // Initial state values
  messagesKey?: string;                 // Key for messages in state (default: "messages")
  jsonTarget?: "messages" | "state";    // Where to extract structured JSON from

  // History
  fetchStateHistory?: boolean | { limit: number }; // Load thread history on mount

  // Streaming
  throttle?: number | boolean;          // Throttle updates (ms or true for 16ms)
  schema?: TSchema;                     // Schema for structured output typing

  // Reconnection
  reconnectOnMount?: boolean | (() => RunMetadataStorage); // Auto-reconnect to interrupted streams

  // Reducers
  transform?: TransformReducers<TState>; // Transform raw values before storing
  merge?: MergeReducers<TState>;        // Merge incoming values with existing state

  // Callbacks
  onStateUpdate?: <K extends keyof TState>(key: K, value: TState[K]) => void;
  onStructuredBlock?: (block: StructuredBlock<TSchema>) => void;
  onToolUpdate?: (tool: ToolState) => void;
  onUIError?: (error: Error) => void;
  onError?: (error: unknown) => void;
  onFinish?: (state: ThreadState<TState>) => void;
  onCustomEvent?: (data: unknown, options: { namespace: string[]; mutate: Function }) => void;
  onCreated?: (run: { run_id: string; thread_id: string }) => void;
  onStop?: (options: { mutate: Function }) => void;
}
```

### Return Value: `UseStreamUIResult<TState, TSchema>`

```typescript
interface UseStreamUIResult<TState, TSchema> {
  // State
  values: TState;                       // Raw state values from server
  state: Partial<TState>;               // Transformed/merged state
  error: unknown;                       // Current error if any
  
  // Loading States
  isLoading: boolean;                   // True while streaming
  isThreadLoading: boolean;             // True while loading thread/history
  
  // Messages & Tools
  messages: Message[];                  // Raw messages array
  uiMessages: MessageWithBlocks<TSchema>[]; // Parsed messages with blocks
  tools: ToolState[];                   // Tool execution states
  
  // History & Branching
  history: ThreadState<TState>[];       // Thread state history
  branch: string;                       // Current branch/checkpoint
  experimental_branchTree: Sequence<TState>; // Branch tree for navigation
  interrupt: Interrupt | undefined;     // Current interrupt if any
  
  // Actions
  submit: (input: TState, options?: UISubmitOptions) => Promise<void>;
  stop: () => Promise<void>;
  setBranch: (branch: string) => Promise<void>;
  setState: (partial: Partial<TState>) => void;
  joinStream: (runId: string, lastEventId?: string, options?: { streamMode?: StreamMode[] }) => Promise<void>;
  getSubgraphState: (namespace: string) => Partial<TState> | undefined;
  
  // References
  client: Client;
  assistantId: string;
  threadId: string | null;
}
```

## Thread Management

### Automatic Thread Creation

By default, a new thread is created on the first `submit()`:

```tsx
const { threadId, submit } = useStreamUI({
  apiUrl: "http://localhost:8080/api",
  assistantId: "agent",
  onThreadId: (id) => {
    // Store in URL, localStorage, etc.
    window.history.replaceState({}, "", `?thread=${id}`);
  },
});
```

### Using Existing Threads

```tsx
function Chat() {
  const threadId = new URLSearchParams(window.location.search).get("thread");
  
  const chat = useStreamUI({
    apiUrl: "http://localhost:8080/api",
    assistantId: "agent",
    getInitialThreadId: () => threadId || undefined,
    fetchStateHistory: true, // Load previous messages
    onThreadId: (id) => {
      window.history.replaceState({}, "", `?thread=${id}`);
    },
  });

  return <ChatUI {...chat} />;
}
```

### Controlled Thread ID

```tsx
const [threadId, setThreadId] = useState<string | null>(null);

const chat = useStreamUI({
  apiUrl: "http://localhost:8080/api",
  assistantId: "agent",
  threadId, // Controlled
  onThreadId: setThreadId,
});

// Start new conversation
const newChat = () => setThreadId(null);
```

## Submitting Messages

### Basic Submit

```tsx
const { submit } = useStreamUI(options);

// Simple message
await submit({ messages: [{ role: "user", content: "Hello" }] });

// With additional state
await submit({ 
  messages: [{ role: "user", content: "Search for X" }],
  searchEnabled: true,
});
```

### `UISubmitOptions`

```typescript
interface UISubmitOptions<TState> {
  // Run configuration
  config?: Config & { configurable?: Record<string, unknown> };
  context?: Record<string, unknown>;    // Context passed to configurable
  metadata?: Record<string, unknown>;   // Run metadata
  
  // Checkpoint/branching
  checkpoint?: { checkpoint_id: string } | null; // Start from specific checkpoint
  command?: Command;                    // Resume with command (e.g., after interrupt)
  
  // Interrupts
  interruptBefore?: "*" | string[];     // Interrupt before these nodes
  interruptAfter?: "*" | string[];      // Interrupt after these nodes
  
  // Streaming
  streamMode?: StreamMode[];            // Which stream modes to enable
  streamSubgraphs?: boolean;            // Include subgraph events
  streamResumable?: boolean;            // Enable stream resumption
  durability?: "ephemeral" | "durable"; // Run durability
  
  // Concurrency
  multitaskStrategy?: "reject" | "enqueue" | "rollback" | "interrupt";
  onCompletion?: "delete" | "keep";     // What to do with run on completion
  onDisconnect?: "cancel" | "continue"; // Behavior if client disconnects
  
  // Thread
  threadId?: string;                    // Override thread ID for this request
  
  // Optimistic Updates
  optimisticValues?: Partial<TState> | ((prev: TState) => Partial<TState>);
  optimisticMessage?: string;           // Show user message immediately
}
```

### Optimistic Updates

Show immediate feedback while waiting for the server:

```tsx
const { submit } = useStreamUI(options);

const handleSubmit = (content: string) => {
  submit(
    { messages: [{ role: "user", content }] },
    {
      optimisticMessage: content, // Shows immediately
      optimisticValues: {         // Merge into state immediately
        isProcessing: true,
      },
    }
  );
};
```

## Message Blocks

`uiMessages` contains parsed messages with typed blocks:

```typescript
interface MessageWithBlocks<TSchema> {
  id: string;
  role: "user" | "assistant";
  blocks: Block<TSchema>[];
}

type Block<TSchema> =
  | TextBlock           // Plain text content
  | StructuredBlock<TSchema> // Typed JSON data
  | ReasoningBlock      // AI reasoning/thinking
  | ToolCallBlock;      // Tool invocation
```

### Rendering Blocks

```tsx
function Message({ message }: { message: MessageWithBlocks<MySchema> }) {
  return (
    <div className={`message ${message.role}`}>
      {message.blocks.map((block) => {
        switch (block.type) {
          case "text":
            return <p key={block.id}>{block.content}</p>;
          
          case "structured":
            return <StructuredContent key={block.id} data={block.data} />;
          
          case "reasoning":
            return <ThinkingIndicator key={block.id} content={block.content} />;
          
          case "tool_call":
            return (
              <ToolCall
                key={block.id}
                name={block.toolName}
                input={block.input}
                output={block.output}
                error={block.error}
                status={block.status}
              />
            );
        }
      })}
    </div>
  );
}
```

### Structured Blocks with Schema

```tsx
interface MySchema {
  summary: string;
  items: { id: string; name: string }[];
  confidence: number;
}

const { uiMessages } = useStreamUI<State, MySchema>({
  apiUrl: "http://localhost:8080/api",
  assistantId: "agent",
  onStructuredBlock: (block) => {
    // Called for each structured block
    console.log(block.data.summary); // Typed!
  },
});
```

## State Management

### Transform Reducers

Transform raw server values before storing:

```tsx
interface State {
  headlines: Headline[];
  descriptions: Description[];
}

const { state } = useStreamUI<State>({
  apiUrl: "...",
  assistantId: "ads",
  transform: {
    // Transform raw strings to objects
    headlines: (raw: string[]) => raw.map((text, i) => ({
      id: `headline-${i}`,
      text,
      rejected: false,
      locked: false,
    })),
  },
});
```

### Merge Reducers

Control how incoming values merge with existing state:

```tsx
import { MergeStrategies } from "@langchain/langgraph-sdk/react";

const { state } = useStreamUI<State>({
  apiUrl: "...",
  assistantId: "ads",
  merge: {
    // Append new items, dedupe by id
    headlines: MergeStrategies.appendUnique("id"),
    
    // Always replace with new value
    currentStep: MergeStrategies.replace(),
    
    // Custom merge logic
    items: (existing, incoming, context) => {
      // context.preStreamState has state before stream started
      return [...existing, ...incoming].slice(-10); // Keep last 10
    },
  },
});
```

### Available Merge Strategies

```typescript
const MergeStrategies = {
  // Replace existing with incoming
  replace: () => (existing, incoming) => incoming,
  
  // Append to array, dedupe by key
  appendUnique: (key: string) => (existing, incoming) => {
    const existingIds = new Set(existing.map(item => item[key]));
    return [...existing, ...incoming.filter(item => !existingIds.has(item[key]))];
  },
  
  // Deep merge objects
  deepMerge: () => (existing, incoming) => ({ ...existing, ...incoming }),
};
```

### Local State Updates

```tsx
const { state, setState } = useStreamUI(options);

// Update local state (doesn't affect server)
const toggleHeadline = (id: string) => {
  setState({
    headlines: state.headlines?.map(h =>
      h.id === id ? { ...h, locked: !h.locked } : h
    ),
  });
};
```

## Selector Pattern (Performance)

Use selectors to prevent unnecessary re-renders:

```tsx
// Full hook - re-renders on ANY change
const chat = useStreamUI(options);

// With selector - only re-renders when selected value changes
const messages = useStreamUI(options, (s) => s.uiMessages);
const isLoading = useStreamUI(options, (s) => s.isLoading);
const headlines = useStreamUI(options, (s) => s.state.headlines);
```

### Creating Typed Hooks

```tsx
const options = {
  apiUrl: "http://localhost:8080/api",
  assistantId: "ads",
  // ... other options
};

// Type-safe selector hook
function useAdsChat<T>(selector?: (s: UISnapshot<AdsState>) => T) {
  return useStreamUI<AdsState, unknown, T>(options, selector);
}

// Granular subscription hooks
function useAdsHeadlines() {
  return useAdsChat((s) => s.state.headlines);
}

function useAdsIsLoading() {
  return useAdsChat((s) => s.isLoading);
}

function useAdsActions() {
  return useAdsChat((s) => ({
    submit: s.submit,
    stop: s.stop,
    setState: s.setState,
  }));
}
```

### How Selectors Work

The hook uses property access detection to determine which parts of state a component uses:

```tsx
// Only subscribes to uiMessages changes
const messages = useStreamUI(options, (s) => s.uiMessages);

// Subscribes to both state.headlines and state.descriptions
const { headlines, descriptions } = useStreamUI(options, (s) => ({
  headlines: s.state.headlines,
  descriptions: s.state.descriptions,
}));
```

## Convenience Hooks

Standalone hooks for common use cases:

```tsx
import {
  useStreamUIState,
  useStreamUIMessages,
  useStreamUITools,
  useSubgraphState,
} from "@langchain/langgraph-sdk/react";

// Subscribe to specific state key
const headlines = useStreamUIState<State, "headlines">({
  apiUrl: "...",
  threadId,
  key: "headlines",
});

// Subscribe to messages only
const messages = useStreamUIMessages<Schema>({
  apiUrl: "...",
  threadId,
});

// Subscribe to tool states only
const tools = useStreamUITools({
  apiUrl: "...",
  threadId,
});

// Subscribe to subgraph state
const subState = useSubgraphState<SubState>({
  apiUrl: "...",
  threadId,
  namespace: "researcher",
});
```

## Reconnection

### Automatic Reconnection on Mount

```tsx
const { joinStream } = useStreamUI({
  apiUrl: "...",
  assistantId: "agent",
  reconnectOnMount: true, // Uses sessionStorage by default
});
```

### Custom Storage

```tsx
const { joinStream } = useStreamUI({
  apiUrl: "...",
  assistantId: "agent",
  reconnectOnMount: () => ({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  }),
});
```

### Manual Reconnection

```tsx
const { joinStream } = useStreamUI(options);

// Rejoin a specific run
await joinStream("run-id-123");

// Resume from specific event
await joinStream("run-id-123", "last-event-id");
```

### How It Works

1. When a stream starts, the run ID is stored with key `lg:stream:${threadId}`
2. On component mount, if `reconnectOnMount` is enabled, it checks storage
3. If a run ID exists, `joinStream` is called automatically
4. On stream completion (success/stop), the storage is cleared
5. On error, storage is preserved for retry

## History and Branching

### Loading History

```tsx
const { history, uiMessages, isThreadLoading } = useStreamUI({
  apiUrl: "...",
  assistantId: "agent",
  getInitialThreadId: () => existingThreadId,
  fetchStateHistory: true, // or { limit: 50 }
});

if (isThreadLoading) return <Loading />;
```

### Branch Navigation

```tsx
const {
  branch,
  setBranch,
  history,
  experimental_branchTree,
} = useStreamUI(options);

// Go to specific checkpoint
await setBranch("checkpoint-id-123");

// Branch tree for visualization
console.log(experimental_branchTree);
// { checkpoint_id: "...", children: [...], state: {...} }
```

### Submitting from Checkpoint

```tsx
const { submit } = useStreamUI(options);

// Continue from specific checkpoint
await submit(
  { messages: [{ role: "user", content: "Try again" }] },
  { checkpoint: { checkpoint_id: "checkpoint-123" } }
);
```

## Interrupts

Handle human-in-the-loop workflows:

```tsx
const { interrupt, submit } = useStreamUI(options);

// Submit with interrupt points
await submit(
  { messages: [{ role: "user", content: "Book a flight" }] },
  { interruptBefore: ["confirm_booking"] }
);

// Render interrupt UI
if (interrupt) {
  return (
    <InterruptDialog
      message={interrupt.value}
      onConfirm={() => {
        submit(
          { messages: [] },
          { command: { resume: { approved: true } } }
        );
      }}
      onReject={() => {
        submit(
          { messages: [] },
          { command: { resume: { approved: false } } }
        );
      }}
    />
  );
}
```

## Tool States

Track tool execution:

```tsx
const { tools } = useStreamUI(options);

// tools: ToolState[]
interface ToolState {
  id: string;
  toolName: string;
  status: "pending" | "running" | "complete" | "error";
  input?: unknown;
  output?: unknown;
  error?: string;
}

// Render tool status
{tools.map((tool) => (
  <ToolStatus key={tool.id} tool={tool} />
))}
```

## Error Handling

```tsx
const { error, submit } = useStreamUI({
  apiUrl: "...",
  assistantId: "agent",
  onError: (err) => {
    console.error("Stream error:", err);
    toast.error("Something went wrong");
  },
  onUIError: (err) => {
    console.error("UI parsing error:", err);
  },
});

if (error) {
  return <ErrorDisplay error={error} onRetry={() => submit(lastInput)} />;
}
```

## Callbacks Reference

```tsx
useStreamUI({
  // Called when a state key updates
  onStateUpdate: (key, value) => {
    console.log(`State ${key} updated:`, value);
  },
  
  // Called for each structured block
  onStructuredBlock: (block) => {
    console.log("Structured:", block.data);
  },
  
  // Called when tool state changes
  onToolUpdate: (tool) => {
    console.log(`Tool ${tool.toolName}: ${tool.status}`);
  },
  
  // Called on UI parsing errors
  onUIError: (error) => {
    console.error("UI error:", error);
  },
  
  // Called on stream errors
  onError: (error) => {
    console.error("Stream error:", error);
  },
  
  // Called when stream completes
  onFinish: (state) => {
    console.log("Finished with state:", state);
  },
  
  // Called for custom events from server
  onCustomEvent: (data, { namespace, mutate }) => {
    console.log("Custom event:", data, namespace);
    mutate({ customData: data }); // Update state
  },
  
  // Called when run is created
  onCreated: ({ run_id, thread_id }) => {
    console.log(`Run ${run_id} created for thread ${thread_id}`);
  },
  
  // Called when stop() is invoked
  onStop: ({ mutate }) => {
    mutate({ cancelled: true });
  },
  
  // Called when thread ID changes
  onThreadId: (threadId) => {
    window.history.replaceState({}, "", `?thread=${threadId}`);
  },
});
```

## Complete Example

```tsx
import { useStreamUI, MergeStrategies } from "@langchain/langgraph-sdk/react";
import { useState } from "react";

interface ChatState {
  messages: { role: string; content: string }[];
  context?: string;
}

interface OutputSchema {
  summary: string;
  sources: string[];
}

function Chat() {
  const [input, setInput] = useState("");
  
  const {
    uiMessages,
    isLoading,
    isThreadLoading,
    error,
    threadId,
    interrupt,
    submit,
    stop,
  } = useStreamUI<ChatState, OutputSchema>({
    apiUrl: process.env.NEXT_PUBLIC_API_URL!,
    assistantId: "research-agent",
    
    // Thread management
    getInitialThreadId: () => 
      new URLSearchParams(window.location.search).get("thread") || undefined,
    onThreadId: (id) => {
      window.history.replaceState({}, "", `?thread=${id}`);
    },
    fetchStateHistory: true,
    
    // Reconnection
    reconnectOnMount: true,
    
    // Callbacks
    onFinish: (state) => {
      console.log("Conversation finished");
    },
    onError: (err) => {
      console.error("Error:", err);
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    
    const message = input;
    setInput("");
    
    await submit(
      { messages: [{ role: "user", content: message }] },
      { optimisticMessage: message }
    );
  };

  if (isThreadLoading) {
    return <div>Loading conversation...</div>;
  }

  if (error) {
    return <div>Error: {String(error)}</div>;
  }

  return (
    <div className="chat-container">
      <div className="messages">
        {uiMessages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.blocks.map((block) => {
              if (block.type === "text") {
                return <p key={block.id}>{block.content}</p>;
              }
              if (block.type === "structured") {
                return (
                  <div key={block.id} className="structured">
                    <h4>{block.data.summary}</h4>
                    <ul>
                      {block.data.sources.map((src, i) => (
                        <li key={i}>{src}</li>
                      ))}
                    </ul>
                  </div>
                );
              }
              if (block.type === "tool_call") {
                return (
                  <div key={block.id} className="tool-call">
                    <span>{block.toolName}</span>
                    <span>{block.status}</span>
                  </div>
                );
              }
              return null;
            })}
          </div>
        ))}
        {isLoading && <div className="typing-indicator">...</div>}
      </div>

      {interrupt && (
        <div className="interrupt-dialog">
          <p>{String(interrupt.value)}</p>
          <button onClick={() => submit({}, { command: { resume: true } })}>
            Continue
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || !input.trim()}>
          Send
        </button>
        {isLoading && (
          <button type="button" onClick={stop}>
            Stop
          </button>
        )}
      </form>
    </div>
  );
}
```
