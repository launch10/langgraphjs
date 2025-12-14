# Custom Hono Server

Embed the LangGraph API in your own Hono application for full control over authentication, middleware, and deployment.

## Quick Start

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createLangGraphApi } from "@langchain/langgraph-api/app";
import { myGraph } from "./src/agent";

async function main() {
  // 1. Create the LangGraph API
  const { app, cleanup, registerGraph } = await createLangGraphApi();

  // 2. Register your graph
  await registerGraph("agent", myGraph);

  // 3. Create your server with auth
  const server = new Hono();
  
  server.use("/api/*", async (c, next) => {
    const token = c.req.header("authorization");
    if (!validateToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  // 4. Mount LangGraph API
  server.route("/api", app);

  // 5. Start server
  serve({ fetch: server.fetch, port: 3000 });

  // 6. Graceful shutdown
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });
}

main();
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `REDIS_URL` | No | - | Redis URL (enables horizontal scaling) |
| `LANGGRAPH_WORKERS` | No | `10` | Background worker count |

## API

### `createLangGraphApi(options?)`

Creates a fully configured LangGraph API with storage, routes, and background workers.

```typescript
const { app, cleanup, registerGraph } = await createLangGraphApi({
  postgresUri: process.env.DATABASE_URL,  // or reads from DATABASE_URL
  redisUrl: process.env.REDIS_URL,        // or reads from REDIS_URL  
  workers: 10,                            // or reads from LANGGRAPH_WORKERS
  cors: {
    allow_origins: ["https://myapp.com"],
    allow_credentials: true,
  },
  disableRoutes: {
    store: true,  // disable if not using LangGraph Store
  },
});
```

**Returns:**

| Property | Description |
|----------|-------------|
| `app` | Hono app to mount on your server |
| `cleanup()` | Call on shutdown to close connections |
| `registerGraph(id, graph)` | Register a compiled graph |

### Registering Graphs

```typescript
import { StateGraph, Annotation } from "@langchain/langgraph";

const StateAnnotation = Annotation.Root({
  messages: Annotation<string[]>({
    reducer: (curr, update) => [...curr, ...update],
    default: () => [],
  }),
});

const myGraph = new StateGraph(StateAnnotation)
  .addNode("agent", async (state) => ({ messages: ["Hello!"] }))
  .addEdge("__start__", "agent")
  .addEdge("agent", "__end__")
  .compile();

await registerGraph("my-agent", myGraph);
```

## Middleware Order

Middleware runs in declaration order. Add auth **before** mounting the LangGraph app:

```typescript
const server = new Hono();

// 1. Runs first
server.use("/api/*", authMiddleware);

// 2. Runs second
server.use("/api/*", rateLimitMiddleware);

// 3. LangGraph routes run last
server.route("/api", app);
```

## Full Example

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createLangGraphApi } from "@langchain/langgraph-api/app";
import { chatbot } from "./src/chatbot";
import { researcher } from "./src/researcher";

async function main() {
  const { app, cleanup, registerGraph } = await createLangGraphApi({
    cors: {
      allow_origins: ["https://myapp.com"],
      allow_credentials: true,
    },
  });

  await registerGraph("chatbot", chatbot);
  await registerGraph("researcher", researcher);

  const server = new Hono();

  // Health check (no auth)
  server.get("/health", (c) => c.json({ status: "ok" }));

  // Auth
  server.use("/api/*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const user = await validateToken(auth.slice(7));
    if (!user) {
      return c.json({ error: "Invalid token" }, 401);
    }
    c.set("user", user);
    await next();
  });

  // Logging
  server.use("/api/*", async (c, next) => {
    const start = Date.now();
    await next();
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`);
  });

  // Mount LangGraph
  server.route("/api", app);

  serve({ fetch: server.fetch, port: 3000 }, () => {
    console.log("Server running on http://localhost:3000");
  });

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });
}

main();
```

## Using with React

```typescript
import { useStream } from "@langchain/langgraph-sdk/react";

function Chat() {
  const { messages, submit, isLoading } = useStream({
    apiUrl: "http://localhost:3000/api",
    assistantId: "chatbot",
    headers: { Authorization: `Bearer ${token}` },
  });

  return (
    <div>
      {messages.map((m, i) => <div key={i}>{m.content}</div>)}
      <button onClick={() => submit({ messages: [{ role: "user", content: "Hi!" }] })}>
        Send
      </button>
    </div>
  );
}
```

## Horizontal Scaling

Set `REDIS_URL` to enable multiple server instances:

| Feature | Without Redis | With Redis |
|---------|---------------|------------|
| Multiple instances | Streams lost | Streams shared |
| Run cancellation | Local only | Cross-instance |
| SSE reconnection | Cannot resume | Resumes correctly |

## API Endpoints

All endpoints are compatible with `@langchain/langgraph-sdk`.

| Endpoint | Description |
|----------|-------------|
| `GET /ok` | Health check |
| `GET /info` | Server info |
| `POST /threads` | Create thread |
| `POST /threads/search` | Search threads |
| `GET /threads/:id` | Get thread |
| `GET /threads/:id/state` | Get thread state |
| `POST /threads/:id/runs/stream` | Stream a run |
| `POST /assistants/search` | Search assistants |
| `GET /assistants/:id` | Get assistant |

See the [SDK documentation](https://langchain-ai.github.io/langgraph/cloud/reference/sdk/js_ts_sdk_ref/) for the complete API reference.
