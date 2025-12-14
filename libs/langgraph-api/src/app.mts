import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";

import runs from "./api/runs.mjs";
import threads from "./api/threads.mjs";
import assistants from "./api/assistants.mjs";
import store from "./api/store.mjs";
import meta from "./api/meta.mjs";

import type { Ops, StorageEnv } from "./storage/types.mjs";
import { cors, ensureContentType } from "./http/middleware.mjs";
import { bindLoopbackFetch } from "./loopback.mjs";
import { requestLogger } from "./logging.mjs";
import { queue } from "./queue.mjs";
import { registerFromEnv, setDefaults, GRAPHS } from "./graph/load.mjs";
import type { CompiledGraph } from "@langchain/langgraph";

export interface CorsConfig {
  allow_origins?: string[];
  allow_origin_regex?: string;
  allow_methods?: string[];
  allow_headers?: string[];
  allow_credentials?: boolean;
  expose_headers?: string[];
  max_age?: number;
}

export interface CreateLangGraphApiOptions {
  postgresUri?: string;
  redisUrl?: string;
  workers?: number;
  cors?: CorsConfig;
  disableRoutes?: {
    meta?: boolean;
    assistants?: boolean;
    runs?: boolean;
    threads?: boolean;
    store?: boolean;
  };
  enableRequestLogging?: boolean;
}

export interface LangGraphApi {
  app: Hono<StorageEnv>;
  cleanup: () => Promise<void>;
  registerGraph: (
    graphId: string,
    graph: CompiledGraph<string, Record<string, unknown>>
  ) => Promise<void>;
  registerGraphsFromFiles: (
    graphs: Record<string, string>,
    options?: { cwd?: string }
  ) => Promise<void>;
}

export async function createLangGraphApi(
  options: CreateLangGraphApiOptions = {}
): Promise<LangGraphApi> {
  const postgresUri = options.postgresUri ?? process.env.DATABASE_URL;
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;

  if (!postgresUri) {
    throw new Error(
      "DATABASE_URL environment variable or postgresUri option is required."
    );
  }

  const { createPostgresOps } = await import("./storage/postgres/index.mjs");
  const postgresOps = await createPostgresOps({
    postgresUri,
    redisUrl,
  });

  const postgresCheckpointer = await postgresOps.getCheckpointer();
  const postgresStore = await postgresOps.getStore();
  setDefaults({
    checkpointer: postgresCheckpointer,
    store: postgresStore,
  });

  const ops: Ops = postgresOps;

  const app = new Hono<StorageEnv>();

  app.use(contextStorage());
  app.use(async (c, next) => {
    c.set("LANGGRAPH_OPS", ops);
    await next();
  });

  bindLoopbackFetch(app);

  app.use(cors(options.cors));

  if (options.enableRequestLogging !== false) {
    app.use(requestLogger());
  }

  app.use(ensureContentType());

  if (!options.disableRoutes?.meta) app.route("/", meta);
  if (!options.disableRoutes?.assistants) app.route("/", assistants);
  if (!options.disableRoutes?.runs) app.route("/", runs);
  if (!options.disableRoutes?.threads) app.route("/", threads);
  if (!options.disableRoutes?.store) app.route("/", store);

  const numWorkers =
    options.workers ?? parseInt(process.env.LANGGRAPH_WORKERS ?? "10", 10);
  for (let i = 0; i < numWorkers; i++) {
    queue(ops);
  }

  const NAMESPACE_GRAPH = "6ba7b821-9dad-11d1-80b4-00c04fd430c8";

  const registerGraph = async (
    graphId: string,
    graph: CompiledGraph<string, Record<string, unknown>>
  ) => {
    const { v5: uuidv5 } = await import("uuid");

    GRAPHS[graphId] = graph;

    await ops.assistants.put(
      uuidv5(graphId, NAMESPACE_GRAPH),
      {
        graph_id: graphId,
        name: graphId,
        metadata: { created_by: "system" },
        config: {},
        context: undefined,
        if_exists: "do_nothing",
      },
      undefined
    );
  };

  const registerGraphsFromFiles = async (
    graphs: Record<string, string>,
    fileOptions?: { cwd?: string }
  ) => {
    await registerFromEnv(ops.assistants, graphs, {
      cwd: fileOptions?.cwd ?? process.cwd(),
    });
  };

  const cleanup = () => postgresOps.shutdown();

  return {
    app,
    cleanup,
    registerGraph,
    registerGraphsFromFiles,
  };
}

export { setDefaults };
