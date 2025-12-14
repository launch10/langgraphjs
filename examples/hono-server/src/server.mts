import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { createLangGraphApi } from "@langchain/langgraph-api/app";
import { adsGraph } from "./graph.mjs";

async function main() {
  const postgresUri =
    process.env.DATABASE_URL || "postgresql://localhost:5432/testdb";

  const {
    app: langGraphApp,
    cleanup,
    registerGraph,
  } = await createLangGraphApi({
    postgresUri,
    workers: 2,
    cors: {
      allow_origins: ["http://localhost:5173", "http://127.0.0.1:5173"],
      allow_credentials: true,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await registerGraph("ads", adsGraph.compile() as any);
  console.log("Registered graph: ads");

  const server = new Hono();

  server.use("*", logger());
  server.use(
    "*",
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      credentials: true,
    })
  );

  server.get("/health", (c) =>
    c.json({ status: "ok", timestamp: new Date().toISOString() })
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.route("/api", langGraphApp as any);

  server.notFound((c) => c.json({ error: "Not Found" }, 404));

  const port = parseInt(process.env.PORT || "8080", 10);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serve({ fetch: server.fetch as any, port }, () => {
    console.log(`LangGraph Hono server running on http://localhost:${port}`);
    console.log(`API available at http://localhost:${port}/api`);
    console.log(`\nRegistered assistants:`);
    console.log(
      `  - ads: Ads generation agent with streaming text + JSON blocks`
    );
  });

  const shutdown = async () => {
    console.log("Shutting down...");
    await cleanup();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
