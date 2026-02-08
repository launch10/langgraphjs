import { z } from "zod/v3";

import * as uuid from "uuid";
import type { AssistantsRepo } from "../storage/types.mjs";
import type {
  BaseCheckpointSaver,
  BaseStore,
  CompiledGraph,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { HTTPException } from "hono/http-exception";
import { type CompiledGraphFactory, resolveGraph } from "./load.utils.mjs";
import type { GraphSchema, GraphSpec } from "./parser/index.mjs";
import { getStaticGraphSchema } from "./parser/index.mjs";
import { checkpointer as fileCheckpointer } from "../storage/checkpoint.mjs";
import { store as fileStore } from "../storage/store.mjs";

// Default checkpointer and store - can be overridden by setDefaults()
let defaultCheckpointer: BaseCheckpointSaver | undefined = fileCheckpointer;
let defaultStore: BaseStore | undefined = fileStore;

/**
 * Set the default checkpointer and store for all graphs.
 * Called by server.mts to override file-based defaults with postgres versions.
 * Pass null to explicitly disable (don't fall back to file-based).
 */
export function setDefaults(options: {
  checkpointer?: BaseCheckpointSaver | null;
  store?: BaseStore | null;
}) {
  if ("checkpointer" in options) {
    defaultCheckpointer = options.checkpointer ?? undefined;
  }
  if ("store" in options) {
    defaultStore = options.store ?? undefined;
  }
}
import { logger } from "../logging.mjs";

import type { Bridge } from "../utils/bridge.mjs";

export const GRAPHS: Record<
  string,
  CompiledGraph<string> | CompiledGraphFactory<string>
> = {};
export const GRAPH_SPEC: Record<string, GraphSpec> = {};
export const GRAPH_SCHEMA: Record<string, Record<string, GraphSchema>> = {};
export const BRIDGES: Record<string, Bridge<Record<string, unknown>>> = {};

export function getBridge(graphId: string): Bridge<Record<string, unknown>> | undefined {
  return BRIDGES[graphId];
}

export const NAMESPACE_GRAPH = uuid.parse(
  "6ba7b821-9dad-11d1-80b4-00c04fd430c8"
);

const ConfigSchema = z.record(z.record(z.unknown()));

export const getAssistantId = (graphId: string) => {
  if (graphId in GRAPHS) return uuid.v5(graphId, NAMESPACE_GRAPH);
  return graphId;
};

export async function registerFromEnv(
  assistants: AssistantsRepo,
  specs: Record<string, string>,
  options: { cwd: string }
) {
  const envConfig = process.env.LANGGRAPH_CONFIG
    ? ConfigSchema.parse(JSON.parse(process.env.LANGGRAPH_CONFIG))
    : undefined;

  return await Promise.all(
    Object.entries(specs).map(async ([graphId, rawSpec]) => {
      logger.info(`Registering graph with id '${graphId}'`, {
        graph_id: graphId,
      });

      const { context, ...config } = envConfig?.[graphId] ?? {};
      const { resolved, ...spec } = await resolveGraph(rawSpec, {
        cwd: options.cwd,
      });

      // registering the graph runtime
      GRAPHS[graphId] = resolved;
      GRAPH_SPEC[graphId] = spec;

      await assistants.put(
        uuid.v5(graphId, NAMESPACE_GRAPH),
        {
          graph_id: graphId,
          metadata: { created_by: "system" },
          config,
          context,
          if_exists: "do_nothing",
          name: graphId,
        },
        undefined
      );

      return resolved;
    })
  );
}

export async function getGraph(
  graphId: string,
  config: LangGraphRunnableConfig | undefined,
  options?: {
    checkpointer?: BaseCheckpointSaver | null;
    store?: BaseStore | null;
  }
) {
  assertGraphExists(graphId);

  const compiled =
    typeof GRAPHS[graphId] === "function"
      ? await GRAPHS[graphId](config ?? { configurable: {} })
      : GRAPHS[graphId];

  // Use "in" check to detect if key was explicitly passed (even as undefined/null)
  // This prevents falling back to defaults when caller explicitly passes undefined
  if (options && "checkpointer" in options) {
    compiled.checkpointer = options.checkpointer ?? undefined;
  } else {
    compiled.checkpointer = defaultCheckpointer;
  }

  if (options && "store" in options) {
    compiled.store = options.store === null ? undefined : options.store;
  } else {
    compiled.store = defaultStore;
  }

  return compiled;
}

export function assertGraphExists(graphId: string) {
  if (!GRAPHS[graphId])
    throw new HTTPException(404, {
      message: `Graph "${graphId}" not found`,
    });
}

export function getGraphKeys() {
  return Object.keys(GRAPHS);
}

export async function getCachedStaticGraphSchema(graphId: string) {
  if (!GRAPH_SPEC[graphId])
    throw new HTTPException(404, {
      message: `Spec for "${graphId}" not found`,
    });

  if (!GRAPH_SCHEMA[graphId]) {
    let timeoutMs = 30_000;
    try {
      const envTimeout = Number.parseInt(
        process.env.LANGGRAPH_SCHEMA_RESOLVE_TIMEOUT_MS ?? "0",
        10
      );
      if (!Number.isNaN(envTimeout) && envTimeout > 0) {
        timeoutMs = envTimeout;
      }
    } catch {
      // ignore
    }

    try {
      GRAPH_SCHEMA[graphId] = await getStaticGraphSchema(GRAPH_SPEC[graphId], {
        timeoutMs,
      });
    } catch (error) {
      throw new Error(`Failed to extract schema for "${graphId}"`, {
        cause: error,
      });
    }
  }

  return GRAPH_SCHEMA[graphId];
}
