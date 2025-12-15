import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import * as pg from "pg";
import { createLangGraphApi } from "../src/app.mjs";
import { StateGraph, Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { poolManager } from "../src/storage/postgres/pool.mjs";
import { createBridge } from "../src/utils/bridge.mjs";
import { BRIDGES } from "../src/graph/load.mjs";

const { Pool } = (pg as any).default ?? pg;

const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";

describe("Stream with Bridge Transforms", () => {
  let testDbName: string;
  let testDbUrl: string;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
    testDbName = `lg_bridge_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

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
    
    for (const key of Object.keys(BRIDGES)) {
      delete BRIDGES[key];
    }
  });

  it("should register a graph with a bridge", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    type TransformedState = {
      items: { id: string; value: string }[];
    };

    const bridge = createBridge<TransformedState>({
      jsonTarget: "state",
      transforms: {
        items: (raw) =>
          (raw as string[]).map((value, i) => ({
            id: `item-${i}`,
            value,
          })),
      },
    });

    const StateAnnotation = Annotation.Root({
      ...MessagesAnnotation.spec,
      items: Annotation<{ id: string; value: string }[]>({
        reducer: (_, next) => next,
        default: () => [],
      }),
    });

    const graph = new StateGraph(StateAnnotation)
      .addNode("agent", async () => ({
        messages: [new AIMessage({ content: "Hello" })],
        items: [{ id: "item-0", value: "test" }],
      }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")
      .compile();

    await result.registerGraph("bridge-test", graph as any, { bridge });

    expect(BRIDGES["bridge-test"]).toBe(bridge);
    expect(BRIDGES["bridge-test"].jsonTarget).toBe("state");
    expect(BRIDGES["bridge-test"].transforms?.items).toBeDefined();
  });

  it("should apply bridge transforms via applyTransforms", async () => {
    type TransformedState = {
      headlines: { id: string; text: string; locked: boolean }[];
      descriptions: { id: string; text: string }[];
    };

    const bridge = createBridge<TransformedState>({
      jsonTarget: "state",
      transforms: {
        headlines: (raw) =>
          (raw as string[]).map((text, i) => ({
            id: `h-${i}`,
            text,
            locked: false,
          })),
        descriptions: (raw) =>
          (raw as string[]).map((text, i) => ({
            id: `d-${i}`,
            text,
          })),
      },
    });

    const rawParsed = {
      headlines: ["Buy Now", "Limited Offer"],
      descriptions: ["Great deal", "Act fast"],
    };

    const transformed = bridge.applyTransforms(rawParsed);

    expect(transformed.headlines).toEqual([
      { id: "h-0", text: "Buy Now", locked: false },
      { id: "h-1", text: "Limited Offer", locked: false },
    ]);
    expect(transformed.descriptions).toEqual([
      { id: "d-0", text: "Great deal" },
      { id: "d-1", text: "Act fast" },
    ]);
  });

  it("should store bridge in BRIDGES registry when registered", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    const bridge = createBridge<{ count: number }>({
      jsonTarget: "state",
      transforms: {
        count: (raw) => (raw as number) * 2,
      },
    });

    const StateAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (_, next) => next,
        default: () => 0,
      }),
    });

    const graph = new StateGraph(StateAnnotation)
      .addNode("agent", async () => ({ count: 5 }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")
      .compile();

    expect(BRIDGES["count-graph"]).toBeUndefined();

    await result.registerGraph("count-graph", graph, { bridge });

    expect(BRIDGES["count-graph"]).toBe(bridge);
  });

  it("should not store bridge when not provided", async () => {
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    const StateAnnotation = Annotation.Root({
      value: Annotation<string>({
        reducer: (_, next) => next,
        default: () => "",
      }),
    });

    const graph = new StateGraph(StateAnnotation)
      .addNode("agent", async () => ({ value: "test" }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")
      .compile();

    await result.registerGraph("no-bridge-graph", graph);

    expect(BRIDGES["no-bridge-graph"]).toBeUndefined();
  });

  it("bridge transforms should be accessible via getBridge", async () => {
    const { getBridge } = await import("../src/graph/load.mjs");
    
    const result = await createLangGraphApi({
      postgresUri: testDbUrl,
      workers: 0,
    });
    cleanup = result.cleanup;

    type MyState = {
      items: { name: string }[];
    };

    const bridge = createBridge<MyState>({
      jsonTarget: "state",
      transforms: {
        items: (raw) => (raw as string[]).map((name) => ({ name })),
      },
    });

    const StateAnnotation = Annotation.Root({
      items: Annotation<{ name: string }[]>({
        reducer: (_, next) => next,
        default: () => [],
      }),
    });

    const graph = new StateGraph(StateAnnotation)
      .addNode("agent", async () => ({ items: [{ name: "test" }] }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "__end__")
      .compile();

    await result.registerGraph("get-bridge-test", graph, { bridge });

    const retrievedBridge = getBridge("get-bridge-test");
    expect(retrievedBridge).toBe(bridge);
    
    const transformed = retrievedBridge?.applyTransforms({ items: ["a", "b"] });
    expect(transformed).toEqual({
      items: [{ name: "a" }, { name: "b" }],
    });
  });

  it("getBridge should return undefined for unknown graph", async () => {
    const { getBridge } = await import("../src/graph/load.mjs");
    
    expect(getBridge("nonexistent-graph")).toBeUndefined();
  });
});
