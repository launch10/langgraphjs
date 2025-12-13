import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import type { StorageEnv } from "../storage/types.mjs";

const api = new Hono<StorageEnv>();

// Get the version using the same pattern as semver/index.mts
const packageJsonPath = path.resolve(
  url.fileURLToPath(import.meta.url),
  "../../../package.json"
);

let version: string;
let langgraph_js_version: string;
let versionInfoLoaded = false;

const loadVersionInfo = async () => {
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
    version = packageJson.version;
  } catch {
    console.warn("Could not determine version of langgraph-api");
  }

  // Get the installed version of @langchain/langgraph
  try {
    const langgraphPkg = await import("@langchain/langgraph/package.json");
    if (langgraphPkg?.default?.version) {
      langgraph_js_version = langgraphPkg.default.version;
    }
  } catch {
    console.warn("Could not determine version of @langchain/langgraph");
  }
};

// read env variable
const env = process.env;

api.get("/info", async (c) => {
  if (!versionInfoLoaded) {
    await loadVersionInfo();
    versionInfoLoaded = true;
  }

  const langsmithApiKey = env["LANGSMITH_API_KEY"] || env["LANGCHAIN_API_KEY"];

  const langsmithTracing = (() => {
    if (langsmithApiKey) {
      // Check if any tracing variable is explicitly set to "false"
      const tracingVars = [
        env["LANGCHAIN_TRACING_V2"],
        env["LANGCHAIN_TRACING"],
        env["LANGSMITH_TRACING_V2"],
        env["LANGSMITH_TRACING"],
      ];

      // Return true unless explicitly disabled
      return !tracingVars.some((val) => val === "false" || val === "False");
    }
    return undefined;
  })();
  return c.json({
    version,
    langgraph_js_version,
    context: "js",
    flags: {
      assistants: true,
      crons: false,
      langsmith: !!langsmithTracing,
      langsmith_tracing_replicas: true,
    },
  });
});

api.get("/ok", (c) => c.json({ ok: true }));

api.get("/health/ready", async (c) => {
  const ops = c.get("LANGGRAPH_OPS");
  const checks: Record<string, "ok" | "error" | "unavailable"> = {};

  if ("getPool" in ops && typeof ops.getPool === "function") {
    try {
      const pool = await (ops as any).getPool();
      await pool.query("SELECT 1");
      checks.postgres = "ok";
    } catch {
      checks.postgres = "error";
    }
  } else {
    checks.postgres = "unavailable";
  }

  if (
    "streamManager" in ops &&
    ops.streamManager &&
    typeof (ops.streamManager as any).getClient === "function"
  ) {
    try {
      const client = (ops.streamManager as any).getClient();
      if (client?.isOpen) {
        checks.redis = "ok";
      } else {
        checks.redis = "error";
      }
    } catch {
      checks.redis = "error";
    }
  }

  if ("getCheckpointer" in ops && typeof ops.getCheckpointer === "function") {
    try {
      await (ops as any).getCheckpointer();
      checks.checkpointer = "ok";
    } catch {
      checks.checkpointer = "error";
    }
  }

  const healthy = Object.entries(checks)
    .filter(([, status]) => status !== "unavailable")
    .every(([, status]) => status === "ok");

  return c.json(
    { status: healthy ? "ready" : "unhealthy", checks },
    healthy ? 200 : 503
  );
});

export default api;
