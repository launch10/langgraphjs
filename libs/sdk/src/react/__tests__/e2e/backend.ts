#!/usr/bin/env npx tsx
/* eslint-disable no-process-env, @typescript-eslint/no-explicit-any, no-console, @typescript-eslint/no-misused-promises, import/no-extraneous-dependencies */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createLangGraphApi } from "@langchain/langgraph-api/app";
import { adsGraph, adsBridge } from "./graphs/ads.js";
import { sampleGraph } from "./graphs/sample.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4124;
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://user:password@localhost:5436/langgraph";

async function main() {
  const {
    app: langGraphApp,
    cleanup,
    registerGraph,
  } = await createLangGraphApi({
    postgresUri: DATABASE_URL,
    workers: 2,
    cors: {
      allow_origins: ["*"],
      allow_credentials: true,
    },
  });

  await registerGraph("ads", adsGraph.compile() as any, { bridge: adsBridge });
  await registerGraph("sample", sampleGraph.compile() as any);

  const server = new Hono();

  server.use(
    "*",
    cors({
      origin: "*",
      credentials: true,
    })
  );

  server.get("/health", (c) =>
    c.json({ status: "ok", timestamp: new Date().toISOString() })
  );

  server.route("/api", langGraphApp as any);

  server.notFound((c) => c.json({ error: "Not Found" }, 404));

  serve({ fetch: server.fetch as any, port: PORT }, () => {
    console.log(`READY:${PORT}`);
  });

  const shutdown = async () => {
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
