import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import * as pg from "pg";
import { Hono } from "hono";
import { createLangGraphApi } from "../src/app.mjs";
import { StateGraph, Annotation } from "@langchain/langgraph";
import { poolManager } from "../src/storage/postgres/pool.mjs";

const { Pool } = (pg as any).default ?? pg;

const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";

describe("createLangGraphApi", () => {
  let testDbName: string;
  let testDbUrl: string;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    testDbName = `lg_app_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    try {
      await pool.query(`CREATE DATABASE ${testDbName}`);
      testDbUrl = `${TEST_POSTGRES_URL.split("/").slice(0, -1).join("/")}/${testDbName}`;
    } finally {
      await pool.end();
    }
  }, 30000);

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
    await poolManager.shutdown();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await pool.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${testDbName}'
        AND pid <> pg_backend_pid()
      `);
      await pool.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    } finally {
      await pool.end();
    }
  }, 30000);

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
    await poolManager.shutdown();
  });

  it("should throw error without DATABASE_URL", async () => {
    const originalEnv = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      await expect(createLangGraphApi()).rejects.toThrow(
        "DATABASE_URL environment variable or postgresUri option is required."
      );
    } finally {
      if (originalEnv) process.env.DATABASE_URL = originalEnv;
    }
  });

  it("should create api with postgresUri option", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    expect(result.app).toBeInstanceOf(Hono);
    expect(typeof result.cleanup).toBe("function");
    expect(typeof result.registerGraph).toBe("function");
    expect(typeof result.registerGraphsFromFiles).toBe("function");
  });

  it("should create api from DATABASE_URL env var", async () => {
    const originalEnv = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testDbUrl;

    try {
      const result = await createLangGraphApi({ workers: 0 });
      cleanup = result.cleanup;

      expect(result.app).toBeInstanceOf(Hono);
    } finally {
      if (originalEnv) {
        process.env.DATABASE_URL = originalEnv;
      } else {
        delete process.env.DATABASE_URL;
      }
    }
  });

  it("should register a graph programmatically", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    const StateAnnotation = Annotation.Root({
      messages: Annotation<string[]>({
        reducer: (curr, update) => [...curr, ...update],
        default: () => [],
      }),
    });

    const graph = new StateGraph(StateAnnotation)
      .addNode("agent", async (state) => ({ messages: ["Hello!"] }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")
      .compile();

    await result.registerGraph("test-agent", graph);

    const res = await result.app.request("/assistants/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const assistants = await res.json();
    expect(assistants.some((a: any) => a.graph_id === "test-agent")).toBe(true);
  });

  it("should respond to health check", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    const res = await result.app.request("/ok");
    expect(res.status).toBe(200);
  });

  it("should respond to info endpoint", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    const res = await result.app.request("/info");
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info).toHaveProperty("version");
  });

  it("should disable routes when configured", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
      disableRoutes: {
        store: true,
        meta: true,
      },
    });
    cleanup = result.cleanup;

    const storeRes = await result.app.request("/store/items", {
      method: "GET",
    });
    expect(storeRes.status).toBe(404);

    const okRes = await result.app.request("/ok");
    expect(okRes.status).toBe(404);
  });

  it("should work when mounted on a parent Hono app", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    const server = new Hono();

    let authCalled = false;
    server.use("/api/*", async (c, next) => {
      authCalled = true;
      await next();
    });

    server.route("/api", result.app);

    const res = await server.request("/api/ok");
    expect(res.status).toBe(200);
    expect(authCalled).toBe(true);
  });

  it("should respect middleware order - auth runs before routes", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    const server = new Hono();

    server.use("/api/*", async (c, next) => {
      const token = c.req.header("authorization");
      if (token !== "Bearer valid-token") {
        return c.json({ error: "Unauthorized" }, 401);
      }
      await next();
    });

    server.route("/api", result.app);

    const unauthorizedRes = await server.request("/api/ok");
    expect(unauthorizedRes.status).toBe(401);

    const authorizedRes = await server.request("/api/ok", {
      headers: { Authorization: "Bearer valid-token" },
    });
    expect(authorizedRes.status).toBe(200);
  });

  it("should use custom worker count from option", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 2,
    });
    cleanup = result.cleanup;

    expect(result.app).toBeInstanceOf(Hono);
  });

  it("should use LANGGRAPH_WORKERS env var", async () => {
    const originalEnv = process.env.LANGGRAPH_WORKERS;
    process.env.LANGGRAPH_WORKERS = "3";

    try {
      const result = await createLangGraphApi({
        postgresUri: testDbUrl,
      });
      cleanup = result.cleanup;

      expect(result.app).toBeInstanceOf(Hono);
    } finally {
      if (originalEnv) {
        process.env.LANGGRAPH_WORKERS = originalEnv;
      } else {
        delete process.env.LANGGRAPH_WORKERS;
      }
    }
  });
});
