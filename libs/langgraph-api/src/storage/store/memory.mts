import {
  InMemoryStore as BaseMemoryStore,
  type Operation,
  type OperationResults,
} from "@langchain/langgraph";
import { FileSystemPersistence } from "../persist.mjs";
import { StoreInterface } from "./types.mjs";

const conn = new FileSystemPersistence<{
  data: Map<string, any>;
  vectors: Map<string, any>;
}>(".langgraphjs_api.store.json", () => ({
  data: new Map(),
  vectors: new Map(),
}));

export class InMemoryStore extends BaseMemoryStore implements StoreInterface {
  async initialize(cwd: string): Promise<StoreInterface> {
    await conn.initialize(cwd);
    await conn.with(({ data, vectors }) => {
      Object.assign(this, { data, vectors });
    });
    return Promise.resolve(this);
  }

  async flush(): Promise<boolean> {
    await conn.flush();
    return true;
  }

  async clear() {
    await conn.with(({ data, vectors }) => {
      data.clear();
      vectors.clear();
    });
  }

  async batch<Op extends readonly Operation[]>(
    operations: Op,
  ): Promise<OperationResults<Op>> {
    return await conn.with(() => super.batch(operations));
  }

  async get(
    ...args: Parameters<BaseMemoryStore["get"]>
  ): ReturnType<BaseMemoryStore["get"]> {
    return await conn.with(() => super.get(...args));
  }

  async search(
    ...args: Parameters<BaseMemoryStore["search"]>
  ): ReturnType<BaseMemoryStore["search"]> {
    return await conn.with(() => super.search(...args));
  }

  async put(
    ...args: Parameters<BaseMemoryStore["put"]>
  ): ReturnType<BaseMemoryStore["put"]> {
    return await conn.with(() => super.put(...args));
  }

  async listNamespaces(
    ...args: Parameters<BaseMemoryStore["listNamespaces"]>
  ): ReturnType<BaseMemoryStore["listNamespaces"]> {
    return await conn.with(() => super.listNamespaces(...args));
  }

  toJSON() {
    // Prevent serialization of internal state
    return "[InMemoryStore]";
  }

  async start(): Promise<void> {
    // No-op for memory store
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    // No-op for memory store
    return Promise.resolve();
  }

  async end(): Promise<void> {
    // No-op for memory store
    return Promise.resolve();
  }
}
