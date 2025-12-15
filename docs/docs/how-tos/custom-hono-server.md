Custom Hono Server

Embed the LangGraph API in your own Hono application for full control over authentication, middleware, and deployment.

## Quick Start

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createLangGraphApi } from "@langchain/langgraph-api/app";
import { myGraph } from "./src/agent";

async function main() {
  // 1. Create the LangGraph API
  const { app, cleanup, registerGraph } = await createLangGraphApi({
    postgresUri: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    workers: parseInt(process.env.WORKERS || "10"),
    cors: {
      allow_origins: process.env.CORS_ORIGINS?.split(",") || [
        "http://localhost:3000",
      ],
      allow_credentials: true,
    },
  });

  // 2. Register your graph
  await registerGraph("agent", myGraph);

  // 3. Create your server with auth
  const server = new Hono();

  // 4. Add auth before LangGraph
  server.use("/api/*", async (c, next) => {
    const token = c.req.header("authorization");
    if (!validateToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  // 5. Mount LangGraph API
  server.route("/api", app);

  // 6. Start server
  const server = serve(
    {
      fetch: app.fetch,
      port: parseInt(process.env.PORT || "3000"),
    },
    (info) => {
      console.log(`Server running on http://localhost:${info.port}`);
    }
  );

  // 6. Graceful shutdown
  process.on("SIGTERM", async () => {
    await cleanup();
    server.close();
    process.exit(0);
  });
}

main();
```

## Environment Variables

| Variable            | Required | Default | Description                            |
| ------------------- | -------- | ------- | -------------------------------------- |
| `DATABASE_URL`      | Yes      | -       | PostgreSQL connection string           |
| `REDIS_URL`         | No       | -       | Redis URL (enables horizontal scaling) |
| `LANGGRAPH_WORKERS` | No       | `10`    | Background worker count                |

### Required

- [ ] PostgreSQL database configured
- [ ] `DATABASE_URL` environment variable set
- [ ] Proper error handling and logging
- [ ] Graceful shutdown handling (`cleanup()`)

### Recommended

- [ ] Redis for horizontal scaling
- [ ] Authentication middleware
- [ ] CORS configuration for your domains
- [ ] Request logging enabled
- [ ] Health check monitoring (`/ok` endpoint)
- [ ] Worker count tuned for workload

## API

### `createLangGraphApi(options?)`

Creates a fully configured LangGraph API with storage, routes, and background workers.

```typescript
const { app, cleanup, registerGraph } = await createLangGraphApi({
  postgresUri: process.env.DATABASE_URL, // or reads from DATABASE_URL
  redisUrl: process.env.REDIS_URL, // or reads from REDIS_URL
  workers: 10, // or reads from LANGGRAPH_WORKERS
  cors: {
    allow_origins: ["https://myapp.com"],
    allow_credentials: true,
  },
  disableRoutes: {
    store: true, // disable if not using LangGraph Store
  },
});
```

**Returns:**

| Property                   | Description                           |
| -------------------------- | ------------------------------------- |
| `app`                      | Hono app to mount on your server      |
| `cleanup()`                | Call on shutdown to close connections |
| `registerGraph(id, graph)` | Register a compiled graph             |

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

## Using with React

```typescript
import { useStream } from "@langchain/langgraph-sdk/react";

function Chat() {
  // Or `useStreamUI` if you want a UI component
  const { messages, submit, isLoading } = useStream({
    apiUrl: "http://localhost:3000/api",
    assistantId: "chatbot",
    headers: { Authorization: `Bearer ${token}` },
  });

  return (
    <div>
      {messages.map((m, i) => (
        <div key={i}>{m.content}</div>
      ))}
      <button
        onClick={() => submit({ messages: [{ role: "user", content: "Hi!" }] })}
      >
        Send
      </button>
    </div>
  );
}
```

## Horizontal Scaling

Set `REDIS_URL` to enable multiple server instances:

| Feature            | Without Redis | With Redis        |
| ------------------ | ------------- | ----------------- |
| Multiple instances | Streams lost  | Streams shared    |
| Run cancellation   | Local only    | Cross-instance    |
| SSE reconnection   | Cannot resume | Resumes correctly |

### What Breaks Without Redis (Multi-Instance)

- Client on Instance A requests stream → Worker on Instance B processes → Client gets nothing
- Cancel request hits Instance A → Worker running on Instance B → Run keeps going
- Client reconnects to Instance B after disconnect → Event history lost

In short, Redis is the communication layer between instances.

## API Endpoints

All endpoints are compatible with `@langchain/langgraph-sdk`.

| Endpoint                        | Description       |
| ------------------------------- | ----------------- |
| `GET /ok`                       | Health check      |
| `GET /info`                     | Server info       |
| `POST /threads`                 | Create thread     |
| `POST /threads/search`          | Search threads    |
| `GET /threads/:id`              | Get thread        |
| `GET /threads/:id/state`        | Get thread state  |
| `POST /threads/:id/runs/stream` | Stream a run      |
| `POST /assistants/search`       | Search assistants |
| `GET /assistants/:id`           | Get assistant     |

See the [SDK documentation](https://langchain-ai.github.io/langgraph/cloud/reference/sdk/js_ts_sdk_ref/) for the complete API reference.
